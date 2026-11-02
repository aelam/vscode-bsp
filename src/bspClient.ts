import * as vscode from 'vscode';
import { 
    createMessageConnection, 
    MessageConnection, 
    StreamMessageReader, 
    StreamMessageWriter,
    CancellationToken,
    CancellationTokenSource
} from 'vscode-jsonrpc/node';
import { BspProgress, taskId } from './bspProgress';
import { BspDebugSessions } from './bspDebugSessions';
import { BspDiagnostics } from './bspDiagnostics';
import { spawn, ChildProcess } from 'child_process';
import { buildLog, log, logError, logInfo, showBuildOutput } from './logger';
import {
    BuildTarget,
    WorkspaceBuildTargetsResult,
    CompileParams,
    CompileResult,
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
    private launchRequests = new Set<string>();

    constructor(workspaceUri: vscode.Uri, private configPath?: string, onTargetsUpdated?: () => void, private buildSystemManager?: any) {
        this.workspaceUri = workspaceUri;
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

    compile(target: BuildTarget): Promise<CompileResult> {
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

            log(`🔨 Starting compilation for ${target.displayName || targetId}`);
            const result: CompileResult = await this.connection.sendRequest('buildTarget/compile', params, cancellation);
            this.handleCompileResult(result);
            return result;
        });
    }

    test(target: BuildTarget): Promise<TestResult> {
        const targetId = target.id.uri;
        
        return this.executeWithProgress('test', targetId, async (originId, cancellation) => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            let testArgs: string[] = [];
            
            // Get test arguments from BuildSystemManager (if available)
            if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
                try {
                    testArgs = await this.buildSystemManager.getTestArguments(target);
                    log(`🔧 Generated test arguments: [${testArgs.join(', ')}]`);
                } catch (error) {
                    logError('Failed to get test arguments from BuildSystemManager', error);
                }
            }

            const params: TestParams = {
                targets: [{ uri: targetId }],
                originId,
                arguments: testArgs
            };

            log(`🧪 Starting tests for ${target.displayName || targetId}`);
            const result: TestResult = await this.connection.sendRequest('buildTarget/test', params, cancellation);
            this.handleTestResult(result);
            return result;
        });
    }

    run(target: BuildTarget): Promise<RunResult> {
        return this.withLaunchLock(target.id.uri, () => this.runTarget(target));
    }

    private runTarget(target: BuildTarget): Promise<RunResult> {
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

            log(`🏃 Starting run for ${target.displayName || targetId}`);
            const result: RunResult = await this.connection.sendRequest('buildTarget/run', params, cancellation);
            this.handleRunResult(result);
            return result;
        });
    }

    debug(target: BuildTarget): Promise<DebugSessionAddressResult> {
        return this.withLaunchLock(target.id.uri, () => this.debugTarget(target));
    }

    private async debugTarget(target: BuildTarget): Promise<DebugSessionAddressResult> {
        const targetId = target.id.uri;
        
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        await this.stopPreviousDebugSession(targetId);

        // Send the same build arguments as run (configuration + destination) so
        // the debug build targets the selected simulator/device instead of
        // defaulting to Mac Catalyst (which then fails code signing).
        let debugArgs: string[] = [];
        if (this.buildSystemManager && this.buildSystemManager.canHandle(target)) {
            try {
                debugArgs = await this.buildSystemManager.getRunArguments(target);
                log(`🔧 Generated debug arguments: [${debugArgs.join(', ')}]`);
            } catch (error) {
                logError('Failed to get debug arguments from BuildSystemManager', error);
            }
        }

        const params: DebugSessionParams = {
            targets: [{ uri: targetId }],
            originId: this.generateOriginId(),
            arguments: debugArgs
        };

        try {
            log(`🐛 Starting debug for ${target.displayName || targetId}`);
            const result: DebugSessionAddressResult = await this.connection.sendRequest('debugSession/start', params);
            log(`🐛 debugSession/start result: ${JSON.stringify(result)}`);
            await this.handleDebugResult(result, targetId);
            return result;
        } catch (error) {
            logError('Failed to start debug session', error);
            throw error;
        }
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
            logError('BSP server stderr', data.toString());
        });

        // Create JSON-RPC connection
        const reader = new StreamMessageReader(this.serverProcess.stdout);
        const writer = new StreamMessageWriter(this.serverProcess.stdin);
        this.connection = createMessageConnection(reader, writer);
        this.connection.onClose(() => this.clearTaskState());

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
            }
        };

        try {
            const result: InitializeBuildResult = await this.connection.sendRequest('build/initialize', initParams);
            this.serverCapabilities = result.capabilities;
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

        // Handle diagnostics
        this.connection.onNotification('build/publishDiagnostics', (params: PublishDiagnosticsParams) => {
            this.handleDiagnostics(params);
        });

        this.connection.onNotification('build/taskStart', (params: TaskStartParams) => {
            showBuildOutput();
            buildLog(`▶ ${params.message || 'Task started'}`);
            this.progress.start(params, () => {
                let report = (_update: { message?: string; increment?: number }) => {};
                let close = () => {};
                const pending: { message?: string; increment?: number }[] = [];
                let ready = false;
                let finished = false;
                void vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'BSP',
                    cancellable: false
                }, progress => new Promise<void>(resolve => {
                    report = update => progress.report(update);
                    close = resolve;
                    ready = true;
                    for (const update of pending) { report(update); }
                    if (finished) { close(); }
                }));
                return {
                    report: update => ready ? report(update) : pending.push(update),
                    close: () => { finished = true; if (ready) { close(); } }
                };
            });
        });

        this.connection.onNotification('build/taskFinish', (params: TaskFinishParams) => {
            this.progress.finish(params);
            const status = params.status === StatusCode.Ok ? '✓'
                : params.status === StatusCode.Cancelled ? 'Cancelled:' : 'Failed:';
            buildLog(`${status} ${params.message || 'Task finished'} [${taskId(params.taskId)}]`);
            vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task finished'}`, 2000);
        });

        this.connection.onNotification('build/taskProgress', (params: TaskProgressParams) => {
            this.progress.progress(params);
        });

        this.connection.onNotification('build/logMessage', (params: { type: number; message: string; originId?: string }) => {
            const prefix = params.type === 1 ? 'Error: ' : params.type === 2 ? 'Warning: ' : '';
            buildLog(prefix + params.message);
            if (params.type === 1) {
                showBuildOutput();
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
            log('Task cancelled');
            return;
        }
        log(`buildTarget/run result: ${JSON.stringify(result)}`);
        const message = result.statusCode === StatusCode.Ok 
            ? 'Run completed successfully' 
            : 'Run failed';
        
        if (result.statusCode === StatusCode.Ok) {
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showErrorMessage(message);
        }
    }

    private async handleDebugResult(result: DebugSessionAddressResult, targetId: string): Promise<void> {
        try {
            // Parse the debug address (could be DAP over TCP, Unix socket, etc.)
            const debugAddress = result.uri;
            const data = result.data;

            log(`🐛 handleDebugResult: uri=${debugAddress} data=${JSON.stringify(data)}`);
            if (debugAddress.startsWith('tcp://')) {
                // TCP connection for DAP
                const match = debugAddress.match(/tcp:\/\/([^:]+):(\d+)/);
                if (match) {
                    const host = match[1];
                    const port = parseInt(match[2]);

                    // macOS -> launch (program); simulator -> attach (pid).
                    const config: vscode.DebugConfiguration = {
                        type: 'bsp-debug',
                        name: `Debug ${targetId}`,
                        request: data?.request ?? 'attach',
                        connect: { host, port }
                    };
                    if (data?.pid !== undefined) { config.pid = data.pid; }
                    if (data?.program !== undefined) { config.program = data.program; }

                    log(`🐛 built debug config: ${JSON.stringify(config)}`);
                    await this.startVSCodeDebugSession(targetId, config);
                } else {
                    logError(`Debug address did not match tcp regex: ${debugAddress}`, undefined);
                }
            } else if (debugAddress.startsWith('unix://')) {
                // Unix socket connection
                const socketPath = debugAddress.replace('unix://', '');
                
                await this.startVSCodeDebugSession(targetId, {
                    type: 'bsp-debug',
                    name: `Debug ${targetId}`,
                    request: 'attach',
                    connect: {
                        socket: socketPath
                    }
                });
            }
            
            vscode.window.showInformationMessage(`Debug session started for ${targetId}`);
        } catch (error) {
            logError('Failed to start debug session', error);
            vscode.window.showErrorMessage(`Failed to start debug session: ${error}`);
        }
    }

    private async startVSCodeDebugSession(_targetId: string, config: vscode.DebugConfiguration): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder available');
        }

        Object.assign(config, this.debugSessions.configuration(_targetId));
        log(`🐛 calling vscode.debug.startDebugging (folder=${workspaceFolder.uri.fsPath})`);
        const success = await vscode.debug.startDebugging(workspaceFolder, config);
        log(`🐛 startDebugging returned: ${success}`);
        if (!success) {
            throw new Error('Failed to start VSCode debug session');
        }
    }

    private async executeWithProgress<T>(
        operation: string,
        targetId: string,
        task: (originId: string, cancellation: CancellationToken) => Promise<T>
    ): Promise<T> {
        const originId = this.generateOriginId();
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `BSP ${operation}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `${operation} ${targetId}...` });
            this.progress.register(originId, update => progress.report(update));
            const cancellation = new CancellationTokenSource();
            this.cancellations.set(originId, cancellation);
            const subscription = token.onCancellationRequested(() => cancellation.cancel());
            if (token.isCancellationRequested) { cancellation.cancel(); }
            const promise = task(originId, cancellation.token);
            this.activeRequests.set(originId, promise);
            log(`📤 ${operation} request started for ${targetId} (ID: ${originId})`);
            try {
                return await promise;
            } catch (error: any) {
                if (!cancellation.token.isCancellationRequested) {
                    logError(`Failed to ${operation} target`, error);
                    vscode.window.showErrorMessage(`Failed to ${operation} ${targetId}: ${error.message}`);
                }
                throw error;
            } finally {
                subscription.dispose();
                cancellation.dispose();
                this.cancellations.delete(originId);
                this.activeRequests.delete(originId);
                this.progress.unregister(originId);
                log(`${operation} request finished for ${targetId}`);
            }
        });
    }

    private async stopPreviousDebugSession(targetId: string): Promise<void> {
        await this.debugSessions.stop(targetId, message => {
            showBuildOutput();
            buildLog(message);
            log(message);
        });
    }

    private async withLaunchLock<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
        if (this.launchRequests.has(targetId)) {
            throw new Error('Run or Debug is already starting for this target. Wait for it to finish or cancel it.');
        }
        this.launchRequests.add(targetId);
        try { return await operation(); }
        finally { this.launchRequests.delete(targetId); }
    }

    private clearTaskState(): void {
        this.debugSessions.dispose();
        this.cancelAllRequests();
        this.progress.dispose();
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
        for (const cancellation of this.cancellations.values()) { cancellation.cancel(); }
    }
}
