import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;
let buildOutputChannel: vscode.LogOutputChannel | undefined;

export function initializeLogger(channel: vscode.LogOutputChannel) {
    outputChannel = channel;
}

// Keep server output separate from the extension's own log.
export function initializeBuildLogger(channel: vscode.LogOutputChannel) {
    buildOutputChannel = channel;
}

// BSP types 3 (Info) and 4 (Log) remain visible at the default log level.
export function buildLog(message: string, type: number = 3) {
    switch (type) {
        case 1: buildOutputChannel?.error(message); break;
        case 2: buildOutputChannel?.warn(message); break;
        default: buildOutputChannel?.info(message);
    }
}

export function showBuildOutput(preserveFocus: boolean = true) {
    buildOutputChannel?.show(preserveFocus);
}

export function clearBuildOutput() {
    buildOutputChannel?.clear();
}

export function log(message: string, showInConsole: boolean = true) {
    outputChannel?.info(message);
    if (showInConsole) {
        console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}

export function logError(message: string, error?: unknown) {
    const errorMessage = error ? `${message}: ${error}` : message;
    outputChannel?.error(errorMessage);
    console.error(`[${new Date().toLocaleTimeString()}] ERROR: ${errorMessage}`);
}

export function logInfo(message: string) {
    log(message);
}

export function logWarning(message: string) {
    outputChannel?.warn(message);
    console.warn(`[${new Date().toLocaleTimeString()}] WARNING: ${message}`);
}

export function showOutput() {
    outputChannel?.show();
}
