import * as vscode from 'vscode';
import type { BspClient } from './bspClient';
import type { BuildTarget } from './bspTypes';
import { TargetBusyError } from './bspTargetOperations';
import { logError } from './logger';

const confirmations = new WeakSet<BspClient>();

export async function cleanBuildCache(client: BspClient, target: BuildTarget): Promise<void> {
    if (confirmations.has(client)) { return; }
    const blocked = client.cleanCacheBlockedReason;
    if (blocked) {
        void vscode.window.showInformationMessage(blocked);
        return;
    }
    confirmations.add(client);
    try {
        const answer = await vscode.window.showWarningMessage(
            `Clean build cache for ${target.displayName || target.id.uri}?`,
            {
                modal: true,
                detail: 'The build server decides what to remove. Shared build and index caches may affect other targets in this project. '
                    + 'Wait for builds, tests, and indexing in other editors or tools to finish before continuing.'
            },
            'Clean Build Cache'
        );
        if (answer !== 'Clean Build Cache') { return; }
        // Recheck in the client: another task can start while the confirmation is open.
        await client.cleanCache(target);
    } catch (error) {
        if (error instanceof TargetBusyError) {
            void vscode.window.showInformationMessage(error.message);
        } else {
            logError('Clean build cache failed', error);
        }
    } finally {
        confirmations.delete(client);
    }
}
