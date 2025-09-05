#!/usr/bin/env node

// Simple Mock BSP Server for testing UI
const readline = require('readline');

class MockBspServer {
    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        this.setupHandlers();
    }

    setupHandlers() {
        this.rl.on('line', (line) => {
            try {
                if (line.trim() === '') return;
                
                const message = JSON.parse(line);
                this.handleMessage(message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        // Handle process exit
        process.on('SIGINT', () => {
            process.exit(0);
        });
        
        process.on('SIGTERM', () => {
            process.exit(0);
        });
    }

    handleMessage(message) {
        const { id, method, params } = message;

        switch (method) {
            case 'build/initialize':
                this.sendResponse(id, {
                    displayName: 'Mock BSP Server',
                    version: '1.0.0',
                    bspVersion: '2.1.0',
                    capabilities: {
                        compileProvider: { languageIds: ['scala', 'java'] },
                        testProvider: { languageIds: ['scala', 'java'] },
                        runProvider: { languageIds: ['scala', 'java'] },
                        debugProvider: { languageIds: ['scala', 'java'] }
                    }
                });
                break;

            case 'build/initialized':
                // No response needed for notification
                break;

            case 'workspace/buildTargets':
                this.sendResponse(id, {
                    targets: [
                        {
                            id: { uri: 'bsp://workspace/lib' },
                            displayName: 'Library Target',
                            baseDirectory: 'file:///workspace/lib',
                            tags: ['library'],
                            capabilities: {
                                canCompile: true,
                                canTest: false,
                                canRun: false,
                                canDebug: false
                            },
                            languageIds: ['scala'],
                            dependencies: []
                        },
                        {
                            id: { uri: 'bsp://workspace/app' },
                            displayName: 'Application Target',
                            baseDirectory: 'file:///workspace/app',
                            tags: ['application'],
                            capabilities: {
                                canCompile: true,
                                canTest: false,
                                canRun: true,
                                canDebug: true
                            },
                            languageIds: ['scala'],
                            dependencies: [{ uri: 'bsp://workspace/lib' }]
                        },
                        {
                            id: { uri: 'bsp://workspace/tests' },
                            displayName: 'Test Target',
                            baseDirectory: 'file:///workspace/tests',
                            tags: ['test'],
                            capabilities: {
                                canCompile: true,
                                canTest: true,
                                canRun: false,
                                canDebug: false
                            },
                            languageIds: ['scala'],
                            dependencies: [{ uri: 'bsp://workspace/lib' }]
                        }
                    ]
                });
                break;

            case 'buildTarget/compile':
                this.sendNotification('build/taskStart', {
                    taskId: { id: 'compile-' + Date.now() },
                    eventTime: Date.now(),
                    message: 'Starting compilation...'
                });
                
                setTimeout(() => {
                    this.sendNotification('build/taskFinish', {
                        taskId: { id: 'compile-' + Date.now() },
                        eventTime: Date.now(),
                        message: 'Compilation completed',
                        status: 1
                    });
                }, 1000);

                this.sendResponse(id, {
                    originId: params.originId,
                    statusCode: 1
                });
                break;

            case 'buildTarget/test':
                this.sendResponse(id, {
                    originId: params.originId,
                    statusCode: 1
                });
                break;

            case 'buildTarget/run':
                this.sendResponse(id, {
                    originId: params.originId,
                    statusCode: 1
                });
                break;

            case 'debugSession/start':
                this.sendResponse(id, {
                    uri: 'tcp://localhost:5005'
                });
                break;

            case 'build/shutdown':
                this.sendResponse(id, null);
                break;

            case 'build/exit':
                process.exit(0);
                break;

            default:
                if (id) {
                    this.sendError(id, -32601, `Method not found: ${method}`);
                }
        }
    }

    sendResponse(id, result) {
        const response = {
            jsonrpc: '2.0',
            id: id,
            result: result
        };
        console.log(JSON.stringify(response));
    }

    sendError(id, code, message) {
        const response = {
            jsonrpc: '2.0',
            id: id,
            error: {
                code: code,
                message: message
            }
        };
        console.log(JSON.stringify(response));
    }

    sendNotification(method, params) {
        const notification = {
            jsonrpc: '2.0',
            method: method,
            params: params
        };
        console.log(JSON.stringify(notification));
    }

    start() {
        console.error('Mock BSP Server started');
    }
}

// Start the server
const server = new MockBspServer();
server.start();
