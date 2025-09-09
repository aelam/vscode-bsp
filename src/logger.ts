import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initializeLogger(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

export function log(message: string, showInConsole: boolean = true) {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `[${timestamp}] ${message}`;
    
    outputChannel?.appendLine(fullMessage);
    
    if (showInConsole) {
        console.log(fullMessage);
    }
}

export function logError(message: string, error?: any) {
    const timestamp = new Date().toLocaleTimeString();
    const errorMessage = error ? `${message}: ${error}` : message;
    const fullMessage = `[${timestamp}] ERROR: ${errorMessage}`;
    
    outputChannel?.appendLine(fullMessage);
    console.error(fullMessage);
}

export function logInfo(message: string) {
    log(`INFO: ${message}`);
}

export function logWarning(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = `[${timestamp}] WARNING: ${message}`;
    
    outputChannel?.appendLine(fullMessage);
    console.warn(fullMessage);
}

export function showOutput() {
    outputChannel?.show();
}
