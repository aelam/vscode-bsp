import * as vscode from 'vscode';
import { 
    createMessageConnection, 
    MessageConnection, 
    StreamMessageReader, 
    StreamMessageWriter 
} from 'vscode-jsonrpc/node';
import { spawn, ChildProcess } from 'child_process';
import { logError, logInfo } from './logger';
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

    constructor(workspaceUri: vscode.Uri, private configPath?: string) {
        this.workspaceUri = workspaceUri;
        this.diagnosticsCollection = vscode.languages.createDiagnosticCollection('bsp');
    }

    async connect(): Promise<void> {
        if (this.isConnected) {
            logInfo('BSP client already connected');
            return;
        }

        try {
            console.log('🔗 BSP Client: Starting connection process...');
            
            // Find BSP connection configuration
            this.connectionDetails = await this.findBspConnectionDetails();
            if (!this.connectionDetails) {
                throw new Error('No BSP connection configuration found');
            }
            console.log('📋 BSP Client: Found connection details:', this.connectionDetails.name);

            // Start BSP server process
            console.log('🚀 BSP Client: Starting BSP server process...');
            await this.startBspServer();

            // Initialize connection
            console.log('🤝 BSP Client: Initializing connection...');
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
            console.log('BSP client disconnected');
        } catch (error) {
            console.error('Error during BSP client disconnect:', error);
        }
    }

    async getBuildTargets(): Promise<BuildTarget[]> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        try {
            console.log('📦 BSP Client: Requesting build targets...');
            const result: WorkspaceBuildTargetsResult = await this.connection.sendRequest('workspace/buildTargets');
            this.buildTargets = result.targets;
            console.log(`✅ BSP Client: Found ${this.buildTargets.length} build targets:`, 
                this.buildTargets.map(t => t.displayName || t.id.uri));
            return this.buildTargets;
        } catch (error) {
            console.error('❌ Failed to get build targets:', error);
            throw error;
        }
    }

    async compile(targetId: string): Promise<CompileResult> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        const params: CompileParams = {
            targets: [{ uri: targetId }],
            originId: this.generateOriginId()
        };

        try {
            const result: CompileResult = await this.connection.sendRequest('buildTarget/compile', params);
            this.handleCompileResult(result);
            return result;
        } catch (error) {
            console.error('Failed to compile target:', error);
            throw error;
        }
    }

    async test(targetId: string): Promise<TestResult> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        const params: TestParams = {
            targets: [{ uri: targetId }],
            originId: this.generateOriginId()
        };

        try {
            const result: TestResult = await this.connection.sendRequest('buildTarget/test', params);
            this.handleTestResult(result);
            return result;
        } catch (error) {
            console.error('Failed to test target:', error);
            throw error;
        }
    }

    async run(targetId: string): Promise<RunResult> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        const params: RunParams = {
            target: { uri: targetId },
            originId: this.generateOriginId()
        };

        try {
            const result: RunResult = await this.connection.sendRequest('buildTarget/run', params);
            this.handleRunResult(result);
            return result;
        } catch (error) {
            console.error('Failed to run target:', error);
            throw error;
        }
    }

    async debug(targetId: string): Promise<DebugSessionAddressResult> {
        if (!this.connection) {
            throw new Error('BSP client not connected');
        }

        const params: DebugSessionParams = {
            targets: [{ uri: targetId }]
        };

        try {
            const result: DebugSessionAddressResult = await this.connection.sendRequest('debugSession/start', params);
            this.handleDebugResult(result, targetId);
            return result;
        } catch (error) {
            console.error('Failed to start debug session:', error);
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
                    bspVersion: config.bspVersion || '2.1.0',
                    languages: config.languages || [],
                    argv: config.argv
                };
            }
        } catch (error) {
            console.error('Error reading BSP configuration:', error);
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
            console.error('BSP server process error:', error);
            vscode.window.showErrorMessage(`BSP server error: ${error.message}`);
        });

        this.serverProcess.on('exit', (code, signal) => {
            console.log(`BSP server exited with code ${code}, signal ${signal}`);
            this.isConnected = false;
            this.connection = undefined;
            this.serverProcess = undefined;
        });

        // Capture stderr for debugging
        this.serverProcess.stderr.on('data', (data) => {
            console.error('BSP server stderr:', data.toString());
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
            console.log('BSP server initialized:', result);

            // Send initialized notification
            this.connection.sendNotification('build/initialized');
        } catch (error) {
            console.error('Failed to initialize BSP connection:', error);
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
            console.log('Task started:', params);
            vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task started'}`, 2000);
        });

        this.connection.onNotification('build/taskFinish', (params: any) => {
            console.log('Task finished:', params);
            vscode.window.setStatusBarMessage(`BSP: ${params.message || 'Task finished'}`, 2000);
        });

        // Handle task progress
        this.connection.onNotification('build/taskProgress', (params: any) => {
            console.log('Task progress:', params);
        });

        // Handle log messages
        this.connection.onNotification('build/logMessage', (params: any) => {
            console.log('BSP log:', params.message);
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
            console.error('Failed to start debug session:', error);
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

    private generateOriginId(): string {
        return `vscode-bsp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    get connected(): boolean {
        return this.isConnected;
    }

    get targets(): BuildTarget[] {
        return this.buildTargets;
    }
}
