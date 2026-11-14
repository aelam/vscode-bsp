import * as vscode from 'vscode';
import type { BspClient } from './bspClient';
import type { TargetOperation } from './bspTargetOperations';

function targetLabel(client: BspClient, targetId: string): string {
    return targetId === 'workspace' ? 'Workspace'
        : client.targets.find(target => target.id.uri === targetId)?.displayName ?? targetId;
}

export function connectionActivity(client: BspClient): {
    description: string; tooltip: string; canCancel: boolean;
} | undefined {
    const operations = client.operations.entries;
    const tasks = [
        ...operations.map(({ targetId, operation }) => ({
            description: operation.description,
            detail: `${targetLabel(client, targetId)}: ${operation.description}`
        })),
        ...client.backgroundTasks.active.map(task => {
            const phase = task.message && task.message !== task.title ? ` · ${task.message}` : '';
            const percent = task.percent === undefined ? '' : ` · ${Math.floor(task.percent)}%`;
            const description = `${task.title}${phase}${percent}`.replace(/\s+/g, ' ');
            return { description, detail: `${description} (background task)` };
        })
    ];
    if (!tasks.length) { return undefined; }
    const summary = tasks.length === 1 ? tasks[0].description : `${tasks.length} tasks running`;
    return {
        description: summary.length > 80 ? summary.slice(0, 79) + '…' : summary,
        tooltip: tasks.map(task => task.detail).join('\n'),
        canCancel: operations.some(({ operation }) => operation.cancellable && !operation.cancelling)
    };
}

export async function cancelConnectionOperation(client: BspClient): Promise<void> {
    const entries = client.operations.entries.filter(({ operation }) => operation.cancellable && !operation.cancelling);
    if (!entries.length) { return; }
    let selected: TargetOperation[];
    if (entries.length === 1) {
        selected = [entries[0].operation];
    } else {
        const choices = entries.map(({ targetId, operation }) => ({
            label: targetLabel(client, targetId), description: operation.description, operations: [operation]
        }));
        choices.push({ label: 'Cancel all operations', description: 'This connection only',
            operations: entries.map(entry => entry.operation) });
        selected = (await vscode.window.showQuickPick(choices, { placeHolder: 'Select an operation to cancel' }))?.operations ?? [];
    }
    const active = new Set(client.operations.entries.map(entry => entry.operation));
    for (const operation of selected) {
        if (active.has(operation)) { operation.cancel(); }
    }
}
