import { BspStdio } from './bspStdio';
import { BuildContexts, buildContextExtension, buildContextVersion, ContextOperation, ContextScope, ContextPreferenceStorage } from './buildContext';
import { BspTestEvent, BspTestOptions } from './bspTestEvents';
import { testTaskMessage } from './bspTestReports';
import * as vscode from 'vscode';
import { debugConfiguration } from './debugConfiguration';
import { 
    createMessageConnection, 
    MessageConnection, 
    StreamMessageReader, 
    StreamMessageWriter,
    CancellationToken,
    CancellationTokenSource
} from 'vscode-jsonrpc/node';
import { BspBackgroundTasks } from './bspBackgroundTasks';
import { BspProgress, taskId } from './bspProgress';
import { BspTargetOperations, TargetBusyError, TargetOperationKind } from './bspTargetOperations';
import { BspDebugSessions } from './bspDebugSessions';
import { BspDiagnostics } from './bspDiagnostics';
import { spawn, ChildProcess } from 'child_process';
import { buildLog, log, logError, logInfo, showBuildOutput } from './logger';
import {
    BuildTarget,
    WorkspaceBuildTargetsResult,
    CompileParams,
    CompileResult,
    CleanCacheParams,
    CleanCacheResult,
    TestParams,
    TestResult,
    RunParams,
    RunResult,
    InitializeBuildParams,
    InitializeBuildResult,
    PublishDiagnosticsParams,
    StatusCode,
    DebugSessionParams,
    DebugSessionAddressResult,
    TaskStartParams,
    TaskProgressParams,
    TaskFinishParams,
    BuildServerCapabilities,
    SourcesItem,
    OutputPathItem,
    OutputPathsResult
} from './bspTypes';

export interface BspConnectionDetails {
    name: string;
    version: string;
    bspVersion: string;
    languages: string[];
    argv: string[];
}

export class BspClient {
    private connection: MessageConnection | undefined;
    private serverProcess: ChildProcess | undefined;
    private buildTargets: BuildTarget[] = [];
    private serverCapabilities: BuildServerCapabilities = {};
    private isConnected = false;
    private workspaceUri: vscode.Uri;
    private connectionDetails: BspConnectionDetails | undefined;
    private diagnosticsCollection: vscode.DiagnosticCollection;
    private activeRequests = new Map<string, Promise<any>>();
    private progress = new BspProgress();
    private diagnostics = new BspDiagnostics();
    private cancellations = new Map<string, CancellationTokenSource>();
    private onTargetsUpdated?: () => void;
    private debugSessions: BspDebugSessions;
    readonly operations = new BspTargetOperations();
    readonly backgroundTasks = new BspBackgroundTasks();
    private testListeners = new Set<(event: BspTestEvent) => void>();
    private testOrigins = new Set<string>();
    private testTasks = new Set<string>();
    prepareExecutionContext?: (scope: ContextScope, operation: ContextOperation, token: CancellationToken) => Promise<boolean>;
    readonly contexts = new BuildContexts(<T>(method: string, params: unknown, token: CancellationToken): Promise<T> => {
        if (!this.connection) { return Promise.reject(new Error('BSP client not connected')); }
        return this.connection.sendRequest<T>(method, params, token);
    });

    onTestEvent(listener: (event: BspTestEvent) => void): vscode.Disposable {
        this.testListeners.add(listener);
        return { dispose: () => { this.testListeners.delete(listener); } };
    }

    private emitTestEvent(event: BspTestEvent): void {
        for (const listener of this.testListeners) {
            try { listener(event); }
            catch (error) { logError('Failed to update test results', error); }
        }
    }

    get supportsTesting(): boolean { return this.serverCapabilities.testProvider !== undefined; }

    supportsOperation(operation: ContextOperation, target?: BuildTarget): boolean {
        const providers = { compile: 'compileProvider', run: 'runProvider', test: 'testProvider', debug: 'debugProvider' } as const;
        const capabilities = { compile: 'canCompile', run: 'canRun', test: 'canTest', debug: 'canDebug' } as const;
        const provider = this.serverCapabilities[providers[operation]];
        return !!provider && (!target || target.capabilities[capabilities[operation]] === true
            && target.languageIds.some(language => provider.languageIds.includes(language)));
    }


    constructor(workspaceUri: vscode.Uri, private configPath?: string, onTargetsUpdated?: () => void,
        private buildSystemManager?: any, preferences?: ContextPreferenceStorage) {
        this.workspaceUri = workspaceUri;
        const root = workspaceUri.toString();
        this.contexts.attachPreferences(preferences, JSON.stringify([root, configPath ?? null]), root);
        this.debugSessions = new BspDebugSessions(configPath ?? workspaceUri.fsPath);
        this.diagnosticsCollection = vscode.languages.createDiagnosticCollection('bsp');
        this.onTargetsUpdated = onTargetsUpdated;
        
        // Debug: Check BuildSystemManager instance
        if (this.buildSystemManager) {
            log(`🔧 BspClient: BuildSystemManager instance ID: ${this.buildSystemManager.instanceId || 'no-id'}`);
            log(`🔧 BspClient: BuildSystemManager debug info: ${JSON.stringify(this.buildSystemManager.getDebugInfo(), null, 2)}`);
        }
    }

    async connect(): Promise<void> {
        if (this.isConnected) {
            logInfo('BSP client already connected');
            return;
        }

        try {
            log('🔗 BSP Client: Starting connection process...');
            
            // Find BSP connection configuration
            this.connectionDetails = await this.findBspConnectionDetails();
            if (!this.connectionDetails) {
                throw new Error('No BSP connection configuration found');
            }
            log(`📋 BSP Client: Found connection details: ${this.connectionDetails.name}`);

            // Start BSP server process
            log('🚀 BSP Client: Starting BSP server process...');
            await this.startBspServer();

            // Initialize connection
            log('🤝 BSP Client: Initializing connection...');
            await this.initializeConnection();

            this.isConnected = true;
            this.emitTestEvent({ kind: 'connected' });
            logInfo('✅ BSP client connected successfully');
        } catch (error) {
            logError('❌ Failed to connect BSP client', error);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (!this.isConnected) {
            return;
        }

        try {
            if (this.connection) {
                // Send shutdown request
                await this.connection.sendRequest('build/shutdown');
                
                // Send exit notification
                this.connection.sendNotification('build/exit');
                
                // Dispose connection
                this.connection.dispose();
                this.connection = undefined;
            }

            if (this.serverProcess) {
                this.serverProcess.kill();
                this.serverProcess = undefined;
            }

            this.isConnected = false;
            this.clearTaskState();
            this.diagnosticsCollection.clear();
            log('BSP client disconnected');
        } catch (error) {
            logError('Error during BSP client disconnect', error);
        }
    }

    async getBuildTargets(): Promise<BuildTarget[]> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        try {
            log('📦 BSP Client: Requesting build targets...');
            const result: WorkspaceBuildTargetsResult = await this.connection.sendRequest('workspace/buildTargets');
            this.buildTargets = result.targets;
            this.emitTestEvent({ kind: 'targets' });
            log(`✅ BSP Client: Found ${this.buildTargets.length} build targets: ${this.buildTargets.map(t => t.displayName || t.id.uri).join(', ')}`);
            
            // Notify that targets have been updated
            if (this.onTargetsUpdated) {
                this.onTargetsUpdated();
            }
            
            return this.buildTargets;
        } catch (error) {
            logError('❌ Failed to get build targets', error);
            throw error;
        }
    }

    async getSources(targets: BuildTarget[], token?: CancellationToken): Promise<SourcesItem[]> {
        if (!this.connection) { throw new Error('BSP client not connected'); }
        const result = await this.connection.sendRequest<{ items: SourcesItem[] }>(
            'buildTarget/sources', { targets: targets.map(target => target.id) }, token ?? CancellationToken.None
        );
        return result.items;
    }

    async getOutputPaths(target: BuildTarget): Promise<OutputPathItem[]> {
        if (!this.connection) { throw new Error('BSP client not connected'); }
        if (!this.serverCapabilities.outputPathsProvider) {
            throw new Error('This BSP server does not provide build output paths');
        }
        const result: OutputPathsResult = await this.connection.sendRequest('buildTarget/outputPaths', {
            targets: [target.id]
        });
        const paths = result.items.filter(item => item.target.uri === target.id.uri).flatMap(item => item.outputPaths);
        return [...new Map(paths.map(path => [path.uri, path])).values()];
    }

    get cleanCacheBlockedReason(): string | undefined {
        if (!this.connected) { return 'BSP server not connected'; }
        const operation = this.operations.first;
        if (operation) { return `Cannot clean while this server is busy: ${operation.message}`; }
        const background = this.backgroundTasks.active[0];
        if (background) { return `Cannot clean while this server is busy: ${background.message ?? background.title}`; }
        return undefined;
    }

    async cleanCache(target: BuildTarget): Promise<CleanCacheResult> {
        const blocked = this.cleanCacheBlockedReason;
        if (blocked) { throw new TargetBusyError(blocked, false); }
        return this.executeWithProgress('clean', target.id.uri, async () => {
            const name = target.displayName || target.id.uri;
            showBuildOutput();
            buildLog(`Cleaning build cache for ${name}`);
            try {
                if (!this.connection) { throw new Error('BSP client not connected'); }
                const params: CleanCacheParams = { targets: [target.id] };
                const result = await this.connection.sendRequest<CleanCacheResult>('buildTarget/cleanCache', params);
                if (result?.cleaned !== true) {
                    throw new Error(result?.message || 'The build server did not clean the cache');
                }
                buildLog(`Build cache cleaned for ${name}${result.message ? `: ${result.message}` : ''}`);
                void vscode.window.showInformationMessage(`Build cache cleaned for ${name}`);
                return result;
            } catch (error) {
                const failure = (error as { code?: number })?.code === -32601
                    ? new Error('This BSP server does not support buildTarget/cleanCache') : error;
                buildLog(`Clean failed: ${failure instanceof Error ? failure.message : String(failure)}`, 1);
                throw failure;
            }
        });
    }

    reload(): Promise<void> {
        return this.executeWithProgress('reload', 'workspace', async (originId, cancellation) => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            log('🔄 Starting workspace reload...');
            await this.connection.sendRequest('workspace/reload', cancellation);
            
            // Refresh build targets after reload
            await this.getBuildTargets();
            
            vscode.window.showInformationMessage('Workspace reloaded successfully');
        });
    }

    compile(target: BuildTarget, token?: vscode.CancellationToken): Promise<CompileResult> {
        if (this.contexts.enabled) {
            return this.executeContext('compile', { targets: [target.id] }, token) as Promise<CompileResult>;
        }
        const targetId = target.id.uri;
        
        return this.executeWithProgress('compile', targetId, async (originId, cancellation) => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            let compileArgs: string[] = [];
            
            // Get compile arguments from BuildSystemManager (if available)
            if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
                log(`🔧 Using BuildSystemManager for target: ${targetId}`);
                
                try {
                    compileArgs = await this.buildSystemManager.getCompileArguments(target);
                    log(`🔧 Generated compile arguments: [${compileArgs.join(', ')}]`);
                } catch (error) {
                    logError('Failed to get compile arguments from BuildSystemManager', error);
                }
            } else if (this.buildSystemManager) {
                log(`⚠️ Target ${targetId} is not supported by BuildSystemManager`);
                log(`⚠️ Target dataKind: ${target.dataKind}, data.xcode: ${!!target.data?.xcode}`);
            } else {
                log(`⚠️ BuildSystemManager not available`);
            }

            const params: CompileParams = {
                targets: [{ uri: targetId }],
                originId,
                arguments: compileArgs
            };

            if (cancellation.isCancellationRequested) { throw new Error('Build cancelled'); }
            log(`🔨 Starting compilation for ${target.displayName || targetId}`);
            const result: CompileResult = await this.connection.sendRequest('buildTarget/compile', params, cancellation);
            this.handleCompileResult(result);
            return result;
        }, { token });
    }

    async test(target: BuildTarget, options: BspTestOptions = {}): Promise<TestResult> {
        const targetId = target.id.uri;
        if (!this.supportsTesting || !target.capabilities.canTest) {
            throw new Error('This target does not support testing');
        }
        if (this.contexts.enabled) {
            return this.executeContext('test', { targets: [target.id] }, options.token, options, true, [target]) as Promise<TestResult>;
        }
        return this.executeWithProgress('test', targetId, async (originId, cancellation) => {
            this.testOrigins.add(originId);
            this.emitTestEvent({
                kind: 'started', originId, target,
                cancel: () => this.cancellations.get(originId)?.cancel()
            });
            let status = StatusCode.Error;
            let failure: string | undefined;
            try {
                if (!this.connection) { throw new Error('BSP client not connected'); }
                let testArgs: string[] = [];
                if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
                    testArgs = await this.buildSystemManager.getTestArguments(target);
                }
                if (cancellation.isCancellationRequested) {
                    status = StatusCode.Cancelled;
                    return { statusCode: status, originId };
                }
                const params: TestParams = { targets: [target.id], originId, arguments: testArgs, ...options.selection };
                log(`Starting tests for ${target.displayName || targetId}`);
                const result: TestResult = await this.connection.sendRequest('buildTarget/test', params, cancellation);
                status = result.statusCode;
                if (!options.native) { this.handleTestResult(result); }
                return result;
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                throw error;
            } finally {
                if (cancellation.isCancellationRequested) { status = StatusCode.Cancelled; }
                this.emitTestEvent({ kind: 'finished', originId, status, error: failure });
                this.testOrigins.delete(originId);
                if (!this.testOrigins.size) { this.testTasks.clear(); }
            }
        }, options);
    }

    run(target: BuildTarget): Promise<RunResult> {
        return this.runTarget(target);
    }

    runWithoutBuilding(target: BuildTarget): Promise<RunResult> {
        if (this.contexts.enabled) { return Promise.reject(new Error('This server prepares execution contexts before running. Use Run Target.')); }
        return this.runTarget(target);
    }

    testWithoutBuilding(target: BuildTarget): Promise<TestResult> {
        if (this.contexts.enabled) { return Promise.reject(new Error('This server prepares execution contexts before testing. Use Test Target.')); }
        return this.test(target);
    }

    private runTarget(target: BuildTarget): Promise<RunResult> {
        if (this.contexts.enabled) {
            return this.executeContext('run', { targets: [target.id] }) as Promise<RunResult>;
        }
        const targetId = target.id.uri;
        
        return this.executeWithProgress('run', targetId, async (originId, cancellation) => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            await this.stopPreviousDebugSession(targetId);
            if (cancellation.isCancellationRequested) { throw new Error('Run cancelled'); }
            let runArgs: string[] = [];
            
            // Get run arguments from BuildSystemManager (if available)
            if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
                try {
                    runArgs = await this.buildSystemManager.getRunArguments(target);
                    log(`🔧 Generated run arguments: [${runArgs.join(', ')}]`);
                } catch (error) {
                    logError('Failed to get run arguments from BuildSystemManager', error);
                }
            }

            const params: RunParams = {
                target: { uri: targetId },
                originId,
                arguments: runArgs
            };

            if (cancellation.isCancellationRequested) { throw new Error('Run cancelled'); }
            showBuildOutput();
            buildLog(`▶ Run: ${target.displayName || targetId}`);
            log(`🏃 Starting run for ${target.displayName || targetId}`);
            const result: RunResult = await this.connection.sendRequest('buildTarget/run', params, cancellation);
            this.handleRunResult(result);
            return result;
        });
    }

    debug(target: BuildTarget): Promise<DebugSessionAddressResult> {
        return this.debugTarget(target, target.capabilities?.canTest === true && !target.capabilities.canRun);
    }

    debugTests(target: BuildTarget, token?: vscode.CancellationToken): Promise<DebugSessionAddressResult> {
        return this.debugTarget(target, true, token);
    }

    private debugTarget(target: BuildTarget, testing: boolean, token?: vscode.CancellationToken): Promise<DebugSessionAddressResult> {
        if (this.contexts.enabled) {
            return this.executeContext('debug', { targets: [target.id] }, token, {}, true, [target]) as Promise<DebugSessionAddressResult>;
        }
        return this.executeWithProgress('debug', target.id.uri, async (originId, cancellation) => {
            if (testing && (!target.capabilities.canTest || !target.capabilities.canDebug)) {
                throw new Error('This build target does not support test debugging');
            }
            const result = await this.requestDebugSession(target, originId, cancellation, testing);
            if (cancellation.isCancellationRequested) { throw new Error('Debug cancelled'); }
            this.operations.get(target.id.uri)?.report('Connecting debugger');
            const configuration = this.configurationForDebugResult(result, target.id.uri);
            if (testing) {
                configuration.name = `Debug Tests: ${target.displayName || target.id.uri}`;
                configuration.stopOnEntry = false;
            }
            await this.startVSCodeDebugSession(configuration);
            return result;
        }, { token });
    }

    prepareDebugConfiguration(target: BuildTarget, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration> {
        if (this.contexts.enabled) {
            return this.executeContext('debug', { targets: [target.id] }, token, {}, false, [target]).then(result => {
                const configuration = this.configurationForDebugResult(result as DebugSessionAddressResult, target.id.uri);
                if (target.capabilities.canTest && !target.capabilities.canRun) { configuration.stopOnEntry = false; }
                return configuration;
            });
        }
        return this.executeWithProgress('debug', target.id.uri, async (originId, cancellation) => {
            const testing = target.capabilities?.canTest === true && !target.capabilities.canRun;
            const result = await this.requestDebugSession(target, originId, cancellation, testing);
            if (cancellation.isCancellationRequested) { throw new Error('Debug cancelled'); }
            const configuration = this.configurationForDebugResult(result, target.id.uri);
            if (testing) { configuration.stopOnEntry = false; }
            return configuration;
        }, { token });
    }

    private async requestDebugSession(target: BuildTarget, originId: string, token: CancellationToken, testing = false): Promise<DebugSessionAddressResult> {
        const targetId = target.id.uri;
        
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        await this.stopPreviousDebugSession(targetId);

        // Use the selected arguments for the operation being debugged.
        let debugArgs: string[] = [];
        if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
            try {
                debugArgs = testing
                    ? await this.buildSystemManager.getTestArguments(target)
                    : await this.buildSystemManager.getRunArguments(target);
                log(`🔧 Generated debug arguments: [${debugArgs.join(', ')}]`);
            } catch (error) {
                logError('Failed to get debug arguments from BuildSystemManager', error);
                if (testing) { throw error; }
            }
        }

        const params: DebugSessionParams = {
            targets: [{ uri: targetId }],
            originId,
            arguments: debugArgs
        };
        if (token.isCancellationRequested) { throw new Error('Debug cancelled'); }
        try {
            log(`🐛 Starting debug for ${target.displayName || targetId}`);
            const result: DebugSessionAddressResult = await this.connection.sendRequest(
                'debugSession/start', params, token
            );
            log(`🐛 debugSession/start result: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logError('Failed to start debug session', error);
            throw error;
        }
    }

    executeContext(
        operation: ContextOperation, scope: ContextScope = {}, token?: vscode.CancellationToken,
        options: BspTestOptions = {}, startDebug = true, knownTargets: BuildTarget[] = []
    ): Promise<CompileResult | TestResult | RunResult | DebugSessionAddressResult> {
        return this.executeWithProgress(operation, scope.targets?.[0]?.uri ?? 'workspace', async (originId, cancellation) => {
            if (this.prepareExecutionContext && !await this.prepareExecutionContext(scope, operation, cancellation)) {
                this.cancellations.get(originId)?.cancel();
                throw new Error('Operation cancelled');
            }
            const resolved = await this.contexts.resolve(scope, operation, cancellation);
            if (!this.connection) { throw new Error('BSP client not connected'); }
            this.operations.includeTargets(scope.targets?.[0]?.uri ?? 'workspace', resolved.targets.map(target => target.uri));
            const executionContext = { id: resolved.id };
            if (operation === 'debug' && resolved.targets.some(id =>
                ![...knownTargets, ...this.buildTargets].some(target => target.id.uri === id.uri))) {
                await this.getBuildTargets();
            }
            if (operation === 'run' || operation === 'debug') {
                for (const target of resolved.targets) { await this.stopPreviousDebugSession(target.uri); }
            }
            let testStatus = StatusCode.Error;
            let failure: string | undefined;
            if (operation === 'test') {
                let available = [...knownTargets, ...this.buildTargets];
                if (resolved.targets.some(id => !available.some(target => target.id.uri === id.uri))) {
                    available = await this.getBuildTargets();
                }
                const targets = resolved.targets.map(id => available.find(target => target.id.uri === id.uri));
                if (targets.some(target => !target)) { throw new Error('A resolved test target is no longer available'); }
                this.testOrigins.add(originId);
                for (const target of targets) {
                    this.emitTestEvent({ kind: 'started', originId, target: target!,
                        cancel: () => this.cancellations.get(originId)?.cancel() });
                }
            }
            try {
                if (cancellation.isCancellationRequested) { throw new Error('Operation cancelled'); }
                showBuildOutput();
                buildLog(`${operation}: ${resolved.targets.map(target => target.uri).join(', ')}`);
                const params = operation === 'run'
                    ? { target: resolved.targets[0], originId, executionContext }
                    : { targets: resolved.targets, originId, ...(operation === 'test' ? options.selection : {}), executionContext };
                if (operation === 'debug') {
                    const result = await this.connection.sendRequest<DebugSessionAddressResult>('debugSession/start', params, cancellation);
                    if (cancellation.isCancellationRequested) { throw new Error('Debug cancelled'); }
                    if (startDebug) {
                        const configuration = this.configurationForDebugResult(result, resolved.targets[0].uri);
                        const targets = [...knownTargets, ...this.buildTargets].filter(target =>
                            resolved.targets.some(id => id.uri === target.id.uri));
                        if (targets.length && targets.every(target => target.capabilities.canTest && !target.capabilities.canRun)) {
                            configuration.stopOnEntry = false;
                        }
                        await this.startVSCodeDebugSession(configuration);
                    }
                    return result;
                }
                const result = await this.connection.sendRequest<CompileResult | TestResult | RunResult>(
                    `buildTarget/${operation}`, params, cancellation);
                testStatus = result.statusCode;
                if (operation === 'compile') { this.handleCompileResult(result); }
                else if (operation === 'run') { this.handleRunResult(result); }
                else if (!options.native) { this.handleTestResult(result); }
                return result;
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                throw error;
            } finally {
                if (operation === 'test') {
                    this.emitTestEvent({ kind: 'finished', originId,
                        status: cancellation.isCancellationRequested ? StatusCode.Cancelled : testStatus, error: failure });
                    this.testOrigins.delete(originId);
                    if (!this.testOrigins.size) { this.testTasks.clear(); }
                }
            }
        }, { ...options, token });
    }

    private async findBspConnectionDetails(): Promise<BspConnectionDetails | undefined> {
        try {
            let configFile: vscode.Uri;
            
            if (this.configPath) {
                // Use specific config file path
                configFile = vscode.Uri.file(this.configPath);
            } else {
                // Find first available config in .bsp directory
                const bspDir = vscode.Uri.joinPath(this.workspaceUri, '.bsp');
                const entries = await vscode.workspace.fs.readDirectory(bspDir);
                
                const jsonFile = entries.find(([name, type]) => 
                    type === vscode.FileType.File && name.endsWith('.json')
                );
                
                if (!jsonFile) {
                    return undefined;
                }
                
                configFile = vscode.Uri.joinPath(bspDir, jsonFile[0]);
            }
            
            const content = await vscode.workspace.fs.readFile(configFile);
            const config = JSON.parse(content.toString());
            
            if (config.name && config.argv) {
                return {
                    name: config.name,
                    version: config.version || '1.0.0',
                    bspVersion: config.bspVersion || '2.2.0',
                    languages: config.languages || [],
                    argv: config.argv
                };
            }
        } catch (error) {
            logError('Error reading BSP configuration', error);
        }
        
        return undefined;
    }

    private async startBspServer(): Promise<void> {
        if (!this.connectionDetails) {
            throw new Error('No connection details available');
        }

        const [command, ...args] = this.connectionDetails.argv;
        
        this.serverProcess = spawn(command, args, {
            cwd: this.workspaceUri.fsPath,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!this.serverProcess.stdout || !this.serverProcess.stdin || !this.serverProcess.stderr) {
            throw new Error('Failed to create BSP server process streams');
        }

        // Handle server process errors
        this.serverProcess.on('error', (error) => {
            logError('BSP server process error', error);
            vscode.window.showErrorMessage(`BSP server error: ${error.message}`);
        });

        this.serverProcess.on('exit', (code, signal) => {
            log(`BSP server exited with code ${code}, signal ${signal}`);
            this.clearTaskState();
            this.connection?.dispose();
            this.isConnected = false;
            this.connection = undefined;
            this.serverProcess = undefined;
        });

        // Capture stderr for debugging
        this.serverProcess.stderr.on('data', (data) => {
            log(`BSP server stderr: ${data.toString()}`);
        });

        // Create JSON-RPC connection
        const serverProcess = this.serverProcess;
        const protocol = new BspStdio(message => buildLog(message));
        protocol.on('error', error => {
            logError('Invalid BSP stdout', error);
            serverProcess.kill();
        });
        this.serverProcess.stdout.pipe(protocol);
        const reader = new StreamMessageReader(protocol);
        reader.onError(error => {
            logError('Invalid BSP message', error);
            serverProcess.kill();
        });
        const writer = new StreamMessageWriter(this.serverProcess.stdin);
        this.connection = createMessageConnection(reader, writer);
        this.connection.onClose(() => {
            this.isConnected = false;
            this.clearTaskState();
        });

        // Set up notification handlers
        this.setupNotificationHandlers();

        // Start the connection
        this.connection.listen();
    }

    private async initializeConnection(): Promise<void> {
        if (!this.connection || !this.connectionDetails) {
            throw new Error('Connection not established');
        }

        const initParams: InitializeBuildParams = {
            displayName: 'VSCode BSP Client',
            version: '0.1.0',
            bspVersion: '2.1.0',
            rootUri: this.workspaceUri.toString(),
            capabilities: {
                languageIds: this.connectionDetails.languages
            },
            data: { bspExtensions: { [buildContextExtension]: { version: buildContextVersion } } }
        };

        try {
            const result: InitializeBuildResult = await this.connection.sendRequest('build/initialize', initParams);
            this.serverCapabilities = result.capabilities;
            this.contexts.negotiate(result.data);
            log(`BSP server initialized: ${JSON.stringify(result)}`);

            // Send initialized notification
            this.connection.sendNotification('build/initialized');
        } catch (error) {
            logError('Failed to initialize BSP connection', error);
            throw error;
        }
    }

    private setupNotificationHandlers(): void {
        if (!this.connection) {
            return;
        }

        this.connection.onNotification('buildTarget/didChange', () => {
            void this.getBuildTargets().catch(error => logError('Failed to refresh changed targets', error));
        });

        // Handle diagnostics
        this.connection.onNotification('build/publishDiagnostics', (params: PublishDiagnosticsParams) => {
            this.handleDiagnostics(params);
        });

        this.connection.onNotification('build/taskStart', (params: TaskStartParams) => {
            const parents = typeof params.taskId === 'string' ? [] : params.taskId.parents ?? [];
            const isTest = this.testOrigins.has(params.originId ?? '') || parents.some(id => this.testTasks.has(id));
            if (isTest) { this.testTasks.add(taskId(params.taskId)); }
            this.emitTestEvent({ kind: 'taskStart', params });
            params = { ...params, message: testTaskMessage(params) ?? params.message };
            buildLog(`▶ ${params.message || 'Task started'}`);
            this.progress.start(params, () => this.backgroundTasks.start(params));
            if (!isTest && !this.progress.isBackground(taskId(params.taskId))) { showBuildOutput(); }
        });

        this.connection.onNotification('build/taskFinish', (params: TaskFinishParams) => {
            this.emitTestEvent({ kind: 'taskFinish', params });
            params = { ...params, message: testTaskMessage(params) ?? params.message };
            const background = this.progress.isBackground(taskId(params.taskId));
            this.backgroundTasks.finish(params);
            this.progress.finish(params);
            const status = params.status === StatusCode.Ok ? '✓'
                : params.status === StatusCode.Cancelled ? 'Cancelled:' : 'Failed:';
            const type = params.status === StatusCode.Ok ? 3 : params.status === StatusCode.Cancelled ? 2 : 1;
            buildLog(`${status} ${params.message || 'Task finished'} [${taskId(params.taskId)}]`, type);
            if (!background) { vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task finished'}`, 2000); }
        });

        this.connection.onNotification('build/taskProgress', (params: TaskProgressParams) => {
            this.emitTestEvent({ kind: 'taskProgress', params });
            this.progress.progress(params);
        });

        this.connection.onNotification('build/logMessage', (params: { type: number; message: string; originId?: string }) => {
            this.emitTestEvent({ kind: 'log', params });
            buildLog(params.message, params.type);
            if (params.type === 1) {
                if (!this.testOrigins.has(params.originId ?? '')) { showBuildOutput(); }
                logError(params.message);
            }
        });

        // Handle show message
        this.connection.onNotification('build/showMessage', (params: any) => {
            const message = params.message || 'BSP server message';
            switch (params.type) {
                case 1: // Error
                    vscode.window.showErrorMessage(message);
                    break;
                case 2: // Warning
                    vscode.window.showWarningMessage(message);
                    break;
                case 3: // Info
                case 4: // Log
                default:
                    vscode.window.showInformationMessage(message);
                    break;
            }
        });
    }

    private handleDiagnostics(params: PublishDiagnosticsParams): void {
        const uri = vscode.Uri.parse(params.textDocument.uri);
        const diagnostics = this.diagnostics.update(params).map(diag => {
            const range = new vscode.Range(
                new vscode.Position(diag.range.start.line, diag.range.start.character),
                new vscode.Position(diag.range.end.line, diag.range.end.character)
            );
            
            const severity = this.convertDiagnosticSeverity(diag.severity);
            const vscDiag = new vscode.Diagnostic(range, diag.message, severity);
            
            if (diag.source) {
                vscDiag.source = diag.source;
            }
            if (diag.code !== undefined) {
                vscDiag.code = diag.code;
            }
            
            vscDiag.relatedInformation = diag.relatedInformation?.map(info => new vscode.DiagnosticRelatedInformation(
                new vscode.Location(vscode.Uri.parse(info.location.uri), new vscode.Range(
                    info.location.range.start.line, info.location.range.start.character,
                    info.location.range.end.line, info.location.range.end.character
                )), info.message
            ));
            return vscDiag;
        });

        this.diagnosticsCollection.set(uri, diagnostics);
    }

    private convertDiagnosticSeverity(severity?: number): vscode.DiagnosticSeverity {
        switch (severity) {
            case 1: return vscode.DiagnosticSeverity.Error;
            case 2: return vscode.DiagnosticSeverity.Warning;
            case 3: return vscode.DiagnosticSeverity.Information;
            case 4: return vscode.DiagnosticSeverity.Hint;
            default: return vscode.DiagnosticSeverity.Error;
        }
    }

    private handleCompileResult(result: CompileResult): void {
        if (result.statusCode === StatusCode.Cancelled) {
            log('Task cancelled');
            return;
        }
        log(`buildTarget/compile result: ${JSON.stringify(result)}`);
        const message = result.statusCode === StatusCode.Ok 
            ? 'Compilation completed successfully' 
            : 'Compilation failed';
        
        if (result.statusCode === StatusCode.Ok) {
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showErrorMessage(message);
        }
    }

    private handleTestResult(result: TestResult): void {
        if (result.statusCode === StatusCode.Cancelled) {
            log('Task cancelled');
            return;
        }
        const message = result.statusCode === StatusCode.Ok 
            ? 'Tests completed successfully' 
            : 'Tests failed';
        
        if (result.statusCode === StatusCode.Ok) {
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showErrorMessage(message);
        }
    }

    private handleRunResult(result: RunResult): void {
        if (result.statusCode === StatusCode.Cancelled) {
            buildLog('Run cancelled');
            log('Task cancelled');
            return;
        }
        log(`buildTarget/run result: ${JSON.stringify(result)}`);
        const message = result.statusCode === StatusCode.Ok 
            ? 'Run completed successfully' 
            : 'Run failed';
        buildLog(message, result.statusCode === StatusCode.Ok ? 3 : 1);
        
        if (result.statusCode === StatusCode.Ok) {
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showErrorMessage(message);
        }
    }

    private configurationForDebugResult(result: DebugSessionAddressResult, targetId: string): vscode.DebugConfiguration {
        const config: vscode.DebugConfiguration = {
            ...debugConfiguration(result, `Debug ${targetId}`),
            ...this.debugSessions.configuration(targetId)
        };
        if (result.dataKind === 'lldb') {
            const commands = vscode.workspace.getConfiguration('bsp.debug', this.workspaceUri)
                .get<unknown>('lldbInitCommands', []);
            if (!Array.isArray(commands) || commands.some(command => typeof command !== 'string')) {
                throw new Error('bsp.debug.lldbInitCommands must be an array of strings');
            }
            if (commands.length) { config.initCommands = [...commands]; }
        }
        return config;
    }

    private async startVSCodeDebugSession(config: vscode.DebugConfiguration): Promise<void> {
        const folder = vscode.workspace.getWorkspaceFolder(this.workspaceUri);
        if (!folder) { throw new Error('The BSP workspace is no longer open'); }
        const success = await vscode.debug.startDebugging(folder, config);
        if (!success) { throw new Error('Failed to start VSCode debug session'); }
    }

    private executeWithProgress<T>(
        kind: TargetOperationKind,
        targetId: string,
        task: (originId: string, cancellation: CancellationToken) => Promise<T>,
        options: BspTestOptions = {}
    ): Promise<T> {
        return this.operations.run(targetId, kind, async operation => {
            const originId = this.generateOriginId();
            const execute = async (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => {
                progress.report({ message: operation.message });
                this.progress.register(originId, update => {
                    operation.report(update.message);
                    progress.report(update);
                });
                const cancellation = operation.cancellation;
                this.cancellations.set(originId, cancellation);
                const subscription = token.onCancellationRequested(() => operation.cancel());
                const external = options.token && options.token !== token
                    ? options.token.onCancellationRequested(() => operation.cancel()) : undefined;
                if (token.isCancellationRequested || options.token?.isCancellationRequested) { operation.cancel(); }
                try {
                    const promise = task(originId, cancellation.token);
                    this.activeRequests.set(originId, promise);
                    log(`📤 ${kind} request started for ${targetId} (ID: ${originId})`);
                    return await promise;
                } catch (error: any) {
                    if (!cancellation.token.isCancellationRequested) {
                        logError(`Failed to ${kind} target`, error);
                        if (!options.native) { vscode.window.showErrorMessage(`Failed to ${kind} ${targetId}: ${error.message}`); }
                    }
                    throw error;
                } finally {
                    subscription.dispose();
                    external?.dispose();
                    this.cancellations.delete(originId);
                    this.activeRequests.delete(originId);
                    this.progress.unregister(originId);
                    log(`${kind} request finished for ${targetId}`);
                }
            };
            if (options.native) { return execute({ report() {} }, options.token ?? CancellationToken.None); }
            return vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: kind === 'clean' ? 'BSP: Clean Build Cache' : `BSP ${kind}`,
                cancellable: operation.cancellable
            }, execute);
        });
    }

    private async stopPreviousDebugSession(targetId: string): Promise<void> {
        await this.debugSessions.stop(targetId, message => {
            showBuildOutput();
            buildLog(message);
            log(message);
        });
    }

    private clearTaskState(): void {
        this.contexts.disconnect();
        this.emitTestEvent({ kind: 'disconnected' });
        this.testTasks.clear();
        this.debugSessions.dispose();
        this.cancelAllRequests();
        this.operations.clear();
        this.progress.dispose();
        this.backgroundTasks.clear();
        this.diagnostics.clear();
        this.diagnosticsCollection.clear();
    }

    private generateOriginId(): string {
        return `vscode-bsp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    get connected(): boolean {
        return this.isConnected;
    }

    get targets(): BuildTarget[] {
        return this.buildTargets;
    }

    getActiveRequests(): Map<string, Promise<any>> {
        return new Map(this.activeRequests);
    }

    cancelAllRequests(): void {
        log(`🚫 Cancelling ${this.activeRequests.size} active requests`);
        this.operations.cancelAll();
    }
}
