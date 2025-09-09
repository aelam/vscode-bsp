#!/usr/bin/env node

const { createServer } = require('net');

class MockXcodeBspServer {
    constructor() {
        this.clients = new Set();
        this.initialized = false;
    }

    start() {
        const server = createServer((socket) => {
            console.log('📱 Xcode BSP Server: Client connected');
            this.clients.add(socket);

            let buffer = '';

            socket.on('data', (data) => {
                buffer += data.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        this.handleMessage(socket, line.trim());
                    }
                }
            });

            socket.on('close', () => {
                console.log('📱 Xcode BSP Server: Client disconnected');
                this.clients.delete(socket);
            });

            socket.on('error', (err) => {
                console.error('📱 Xcode BSP Server: Socket error:', err);
                this.clients.delete(socket);
            });
        });

        server.listen(0, () => {
            const port = server.address().port;
            console.log(`📱 Xcode BSP Server started on port ${port}`);
        });

        // Handle stdio communication
        process.stdin.setEncoding('utf8');
        let stdinBuffer = '';

        process.stdin.on('data', (data) => {
            stdinBuffer += data;
            let lines = stdinBuffer.split('\n');
            stdinBuffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    this.handleMessage(process.stdout, line.trim());
                }
            }
        });
    }

    handleMessage(output, message) {
        try {
            const { jsonrpc, id, method, params } = JSON.parse(message);
            console.log(`📱 Xcode BSP Server: Received ${method}`, params ? JSON.stringify(params) : '');

            switch (method) {
                case 'build/initialize':
                    this.sendResponse(output, id, {
                        displayName: 'Mock Xcode BSP Server',
                        version: '1.0.0',
                        bspVersion: '2.1.0',
                        capabilities: {
                            languageIds: ['swift', 'objective-c']
                        }
                    });
                    break;

                case 'build/initialized':
                    this.initialized = true;
                    console.log('📱 Xcode BSP Server: Initialized');
                    break;

                case 'workspace/buildTargets':
                    this.sendResponse(output, id, {
                        targets: [
                            {
                                id: { uri: 'xcode://MyApp.xcodeproj/MyApp' },
                                displayName: 'MyApp (iOS)',
                                baseDirectory: 'file:///workspace/MyApp',
                                tags: ['application', 'ios'],
                                capabilities: {
                                    canCompile: true,
                                    canTest: true,
                                    canRun: true,
                                    canDebug: true
                                },
                                languageIds: ['swift'],
                                dependencies: [],
                                dataKind: 'xcode',
                                data: {
                                    xcode: {
                                        projectPath: '/workspace/MyApp.xcodeproj',
                                        schemes: [
                                            { name: 'Debug', type: 'run', buildable: true },
                                            { name: 'Release', type: 'run', buildable: true },
                                            { name: 'Test', type: 'test', buildable: true }
                                        ],
                                        destinations: [
                                            { 
                                                id: 'ios-sim-15', 
                                                name: 'iPhone 15', 
                                                platform: 'iOS', 
                                                deviceType: 'simulator', 
                                                version: '17.0' 
                                            },
                                            { 
                                                id: 'ios-sim-15-pro', 
                                                name: 'iPhone 15 Pro', 
                                                platform: 'iOS', 
                                                deviceType: 'simulator', 
                                                version: '17.0' 
                                            },
                                            { 
                                                id: 'ios-sim-ipad', 
                                                name: 'iPad Pro 12.9"', 
                                                platform: 'iOS', 
                                                deviceType: 'simulator', 
                                                version: '17.0' 
                                            }
                                        ],
                                        selectedScheme: 'Debug',
                                        selectedDestination: 'ios-sim-15'
                                    }
                                }
                            },
                            {
                                id: { uri: 'xcode://MyApp.xcodeproj/MyAppTests' },
                                displayName: 'MyAppTests',
                                baseDirectory: 'file:///workspace/MyAppTests',
                                tags: ['test', 'ios'],
                                capabilities: {
                                    canCompile: true,
                                    canTest: true,
                                    canRun: false,
                                    canDebug: true
                                },
                                languageIds: ['swift'],
                                dependencies: [{ uri: 'xcode://MyApp.xcodeproj/MyApp' }],
                                dataKind: 'xcode',
                                data: {
                                    xcode: {
                                        projectPath: '/workspace/MyApp.xcodeproj',
                                        schemes: [
                                            { name: 'Test', type: 'test', buildable: true }
                                        ],
                                        destinations: [
                                            { 
                                                id: 'ios-sim-15', 
                                                name: 'iPhone 15', 
                                                platform: 'iOS', 
                                                deviceType: 'simulator', 
                                                version: '17.0' 
                                            }
                                        ],
                                        selectedScheme: 'Test',
                                        selectedDestination: 'ios-sim-15'
                                    }
                                }
                            }
                        ]
                    });
                    break;

                case 'buildTarget/compile':
                    console.log('📱 Compiling Xcode target:', params.targets[0].uri);
                    setTimeout(() => {
                        this.sendResponse(output, id, {
                            originId: params.originId,
                            statusCode: 1
                        });
                    }, 1000);
                    break;

                case 'buildTarget/test':
                    console.log('📱 Testing Xcode target:', params.targets[0].uri);
                    setTimeout(() => {
                        this.sendResponse(output, id, {
                            originId: params.originId,
                            statusCode: 1
                        });
                    }, 2000);
                    break;

                case 'buildTarget/run':
                    console.log('📱 Running Xcode target:', params.targets[0].uri);
                    setTimeout(() => {
                        this.sendResponse(output, id, {
                            originId: params.originId,
                            statusCode: 1
                        });
                    }, 1500);
                    break;

                default:
                    console.log(`📱 Xcode BSP Server: Unknown method ${method}`);
                    this.sendError(output, id, -32601, `Method not found: ${method}`);
            }
        } catch (error) {
            console.error('📱 Xcode BSP Server: Error parsing message:', error);
        }
    }

    sendResponse(output, id, result) {
        const response = {
            jsonrpc: '2.0',
            id,
            result
        };
        const message = JSON.stringify(response);
        
        if (output === process.stdout) {
            process.stdout.write(message + '\n');
        } else {
            output.write(message + '\n');
        }
    }

    sendError(output, id, code, message) {
        const response = {
            jsonrpc: '2.0',
            id,
            error: { code, message }
        };
        const errorMessage = JSON.stringify(response);
        
        if (output === process.stdout) {
            process.stdout.write(errorMessage + '\n');
        } else {
            output.write(errorMessage + '\n');
        }
    }
}

const server = new MockXcodeBspServer();
server.start();

process.on('SIGINT', () => {
    console.log('📱 Xcode BSP Server: Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('📱 Xcode BSP Server: Terminating...');
    process.exit(0);
});