import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;
let buildOutputChannel: vscode.OutputChannel | undefined;

export function initializeLogger(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

/// A dedicated channel ("vscode-bsp-log") for build/compile output streamed
/// from the server, kept separate from the general extension log.
export function initializeBuildLogger(channel: vscode.OutputChannel) {
    buildOutputChannel = channel;
}

/// Append a raw build line to the dedicated build channel (no timestamp so the
/// output reads like real xcodebuild output).
export function buildLog(message: string) {
    buildOutputChannel?.appendLine(message);
}

export function showBuildOutput(preserveFocus: boolean = true) {
    buildOutputChannel?.show(preserveFocus);
}

export function clearBuildOutput() {
    buildOutputChannel?.clear();
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
