import * as vscode from 'vscode';
import { 
    createMessageConnection, 
    MessageConnection, 
    StreamMessageReader, 
    StreamMessageWriter 
} from 'vscode-jsonrpc/node';
import { spawn, ChildProcess } from 'child_process';
import { log, logError, logInfo } from './logger';
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
    DebugSessionAddressResult
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
    private isConnected = false;
    private workspaceUri: vscode.Uri;
    private connectionDetails: BspConnectionDetails | undefined;
    private diagnosticsCollection: vscode.DiagnosticCollection;
    private activeRequests = new Map<string, Promise<any>>();
    private requestCounter = 0;
    private onTargetsUpdated?: () => void;

    constructor(workspaceUri: vscode.Uri, private configPath?: string, onTargetsUpdated?: () => void, private xcodeManager?: any) {
        this.workspaceUri = workspaceUri;
        this.diagnosticsCollection = vscode.languages.createDiagnosticCollection('bsp');
        this.onTargetsUpdated = onTargetsUpdated;
        
        // Debug: Check XcodeManager instance
        if (this.xcodeManager) {
            log(`🔧 BspClient: XcodeManager instance ID: ${this.xcodeManager._instanceId || 'no-id'}`);
            log(`🔧 BspClient: XcodeManager xcodeData Map size: ${this.xcodeManager.getXcodeDataSize()}`);
            log(`🔧 BspClient: XcodeManager xcodeData keys: [${this.xcodeManager.getXcodeDataKeys().join(', ')}]`);
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

    reload(): Promise<void> {
        return this.executeWithProgress('reload', 'workspace', async () => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            log('🔄 Starting workspace reload...');
            await this.connection.sendRequest('workspace/reload');
            
            // Refresh build targets after reload
            await this.getBuildTargets();
            
            vscode.window.showInformationMessage('Workspace reloaded successfully');
        });
    }

    compile(target: BuildTarget): Promise<CompileResult> {
        const targetId = target.id.uri;
        
        return this.executeWithProgress('compile', targetId, async () => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            let compileArgs: string[] = [];
            
            // Get user's selected configuration and destination from XcodeManager (if available)
            if (this.xcodeManager && this.xcodeManager.isXcodeTarget(target)) {
                log(`🔧 Using XcodeManager instance: ${this.xcodeManager.constructor.name}`);
                log(`🔧 XcodeManager instance ID: ${this.xcodeManager._instanceId}`);
                log(`🔧 Target ID: ${targetId}`);
                log(`🔧 Pre-extraction xcodeData Map size: ${this.xcodeManager.getXcodeDataSize()}`);
                log(`🔧 Pre-extraction xcodeData keys: [${this.xcodeManager.getXcodeDataKeys().join(', ')}]`);
                
                // Force extract xcode data to ensure it's available
                // log(`🔧 Extracting xcode data for target...`);
                // const extractedData = this.xcodeManager.extractXcodeData(target);
                // log(`🔧 Extracted data: ${JSON.stringify(extractedData, null, 2)}`);
                
                const selectedConfiguration = this.xcodeManager.getSelectedConfiguration(targetId);
                const selectedDestination = this.xcodeManager.getSelectedDestination(targetId);
                
                log(`🔧 Selected configuration: ${selectedConfiguration || 'none'}`);
                log(`🔧 Selected destination: ${selectedDestination?.id || 'none'}`);
                
                if (selectedConfiguration) {
                    compileArgs.push('-configuration', selectedConfiguration);
                    log(`🔧 Added configuration argument: -configuration ${selectedConfiguration}`);
                }
                if (selectedDestination) {
                    compileArgs.push('-destination', `id=${selectedDestination.id}`);
                    log(`🔧 Added destination argument: -destination id=${selectedDestination.id}`);
                }
            } else if (this.xcodeManager) {
                log(`⚠️ Target ${targetId} is not recognized as Xcode target`);
                log(`⚠️ Target dataKind: ${target.dataKind}, data.xcode: ${!!target.data?.xcode}`);
            } else {
                log(`⚠️ XcodeManager not available`);
            }

            const params: CompileParams = {
                targets: [{ uri: targetId }],
                originId: this.generateOriginId(),
                arguments: compileArgs
            };

            log(`🔨 Starting compilation for ${target.displayName || targetId}`);
            const result: CompileResult = await this.connection.sendRequest('buildTarget/compile', params);
            this.handleCompileResult(result);
            return result;
        });
    }

    test(target: BuildTarget): Promise<TestResult> {
        const targetId = target.id.uri;
        
        return this.executeWithProgress('test', targetId, async () => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            let testArgs: string[] = [];
            
            // Get user's selected configuration and destination from XcodeManager (if available)
            if (this.xcodeManager && this.xcodeManager.isXcodeTarget(target)) {
                const selectedConfiguration = this.xcodeManager.getSelectedConfiguration(targetId);
                const selectedDestination = this.xcodeManager.getSelectedDestination(targetId);
                
                if (selectedConfiguration) {
                    testArgs.push('-configuration', selectedConfiguration);
                }
                if (selectedDestination) {
                    testArgs.push('-destination', `id=${selectedDestination.id}`);
                }
            }

            const params: TestParams = {
                targets: [{ uri: targetId }],
                originId: this.generateOriginId(),
                arguments: testArgs
            };

            log(`🧪 Starting tests for ${target.displayName || targetId}`);
            const result: TestResult = await this.connection.sendRequest('buildTarget/test', params);
            this.handleTestResult(result);
            return result;
        });
    }

    run(target: BuildTarget): Promise<RunResult> {
        const targetId = target.id.uri;
        
        return this.executeWithProgress('run', targetId, async () => {
            if (!this.connection) {
                throw new Error('BSP client not connected');
            }

            let runArgs: string[] = [];
            
            // Get user's selected configuration and destination from XcodeManager (if available)
            if (this.xcodeManager && this.xcodeManager.isXcodeTarget(target)) {
                const selectedConfiguration = this.xcodeManager.getSelectedConfiguration(targetId);
                const selectedDestination = this.xcodeManager.getSelectedDestination(targetId);
                
                if (selectedConfiguration) {
                    runArgs.push('-configuration', selectedConfiguration);
                }
                if (selectedDestination) {
                    runArgs.push('-destination', `id=${selectedDestination.id}`);
                }
            }

            const params: RunParams = {
                target: { uri: targetId },
                originId: this.generateOriginId(),
                arguments: runArgs
            };

            log(`🏃 Starting run for ${target.displayName || targetId}`);
            const result: RunResult = await this.connection.sendRequest('buildTarget/run', params);
            this.handleRunResult(result);
            return result;
        });
    }

    async debug(target: BuildTarget): Promise<DebugSessionAddressResult> {
        const targetId = target.id.uri;
        
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        const params: DebugSessionParams = {
            targets: [{ uri: targetId }]
        };

        try {
            log(`🐛 Starting debug for ${target.displayName || targetId}`);
            const result: DebugSessionAddressResult = await this.connection.sendRequest('debugSession/start', params);
            this.handleDebugResult(result, targetId);
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

        // Handle task start/finish notifications
        this.connection.onNotification('build/taskStart', (params: any) => {
            log(`Task started: ${JSON.stringify(params)}`);
            vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task started'}`, 2000);
        });

        this.connection.onNotification('build/taskFinish', (params: any) => {
            log(`Task finished: ${JSON.stringify(params)}`);
            vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task finished'}`, 2000);
        });

        // Handle task progress
        this.connection.onNotification('build/taskProgress', (params: any) => {
            log(`Task progress: ${JSON.stringify(params)}`);
        });

        // Handle log messages
        this.connection.onNotification('build/logMessage', (params: any) => {
            log(`BSP log: ${params.message}`);
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
        const diagnostics = params.diagnostics.map(diag => {
            const range = new vscode.Range(
                new vscode.Position(diag.range.start.line, diag.range.start.character),
                new vscode.Position(diag.range.end.line, diag.range.end.character)
            );
            
            const severity = this.convertDiagnosticSeverity(diag.severity);
            const vscDiag = new vscode.Diagnostic(range, diag.message, severity);
            
            if (diag.source) {
                vscDiag.source = diag.source;
            }
            if (diag.code) {
                vscDiag.code = diag.code;
            }
            
            return vscDiag;
        });

        if (params.reset) {
            this.diagnosticsCollection.set(uri, diagnostics);
        } else {
            const existing = this.diagnosticsCollection.get(uri) || [];
            this.diagnosticsCollection.set(uri, [...existing, ...diagnostics]);
        }
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
            
            if (debugAddress.startsWith('tcp://')) {
                // TCP connection for DAP
                const match = debugAddress.match(/tcp:\/\/([^:]+):(\d+)/);
                if (match) {
                    const host = match[1];
                    const port = parseInt(match[2]);
                    
                    await this.startVSCodeDebugSession(targetId, {
                        type: 'bsp-debug',
                        name: `Debug ${targetId}`,
                        request: 'attach',
                        connect: {
                            host: host,
                            port: port
                        }
                    });
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

        const success = await vscode.debug.startDebugging(workspaceFolder, config);
        if (!success) {
            throw new Error('Failed to start VSCode debug session');
        }
    }

    private async executeWithProgress<T>(
        operation: string, 
        targetId: string, 
        task: () => Promise<T>
    ): Promise<T> {
        const requestId = `${operation}-${this.requestCounter++}-${targetId}`;
        
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `BSP ${operation}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `${operation} ${targetId}...` });
            
            const promise = task().catch(error => {
                logError(`Failed to ${operation} target`, error);
                vscode.window.showErrorMessage(`Failed to ${operation} ${targetId}: ${error.message}`);
                throw error;
            }).finally(() => {
                this.activeRequests.delete(requestId);
                log(`✅ ${operation} request completed for ${targetId}`);
            });
            
            this.activeRequests.set(requestId, promise);
            log(`📤 ${operation} request started for ${targetId} (ID: ${requestId})`);
            
            // Handle cancellation
            token.onCancellationRequested(() => {
                log(`🚫 ${operation} request cancelled for ${targetId}`);
                this.activeRequests.delete(requestId);
            });
            
            return promise;
        });
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
        this.activeRequests.clear();
    }
}
