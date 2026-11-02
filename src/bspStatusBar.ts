import * as vscode from 'vscode';
import type { BspClient } from './bspClient';
import type { BspConnectionManager } from './bspConnectionManager';
import type { BackgroundTask } from './bspBackgroundTasks';
import { StatusCode } from './bspTypes';

export class BspStatusBar implements vscode.Disposable {
    private item = vscode.window.createStatusBarItem('bsp.backgroundTasks', vscode.StatusBarAlignment.Left, 10);
    private subscriptions: vscode.Disposable[];
    private timer?: ReturnType<typeof setTimeout>;
    private completed?: BackgroundTask;

    constructor(private manager: BspConnectionManager, private legacy?: BspClient) {
        this.item.name = 'BSP background tasks';
        this.item.command = 'bsp.showBuildOutput';
        this.subscriptions = [
            manager.onDidChangeConnections(() => this.render()),
            manager.onDidChangeBackgroundTasks(() => this.render())
        ];
        if (legacy) { this.subscriptions.push(legacy.backgroundTasks.onDidChange(() => this.render())); }
        this.render();
    }

    private render(): void {
        const clients = this.manager.getAllConnections().filter(c => c.connected && c.client.connected)
            .map(c => ({ name: c.config.displayName ?? c.config.name, client: c.client }));
        if (this.legacy?.connected) { clients.push({ name: 'BSP', client: this.legacy }); }
        const active = clients.flatMap(({ name, client }) => client.backgroundTasks.active.map(task => ({ name, task })));
        if (active.length) {
            this.item.backgroundColor = undefined;
            this.clearTimer();
            this.completed = undefined;
            const first = active[0].task;
            const percent = first.percent === undefined ? '' : ` ${Math.floor(first.percent)}%`;
            const phase = first.message && first.message !== first.title ? ` · ${first.message}` : '';
            const summary = `${first.title}${phase}`.replace(/\s+/g, ' ');
            const title = active.length === 1
                ? `${summary.length > 65 ? summary.slice(0, 64) + '…' : summary}${percent}`
                : `${active.length} background tasks`;
            this.item.text = `$(sync~spin) BSP: ${title.replace(/\s+/g, ' ')}`;
            this.item.tooltip = active.map(({ name, task }) =>
                `${name} — ${task.title}\n${task.message ?? ''}${task.percent === undefined ? '' : ` (${Math.floor(task.percent)}%)`}`
            ).join('\n\n') + '\n\nClick to open BSP build output.';
            this.item.show();
            return;
        }
        const results = clients.map(c => c.client.backgroundTasks.last).filter((t): t is BackgroundTask => !!t);
        const last = results.find(t => t.status === StatusCode.Error) ?? results[results.length - 1];
        if (!last) {
            this.clearTimer();
            this.completed = undefined;
            this.item.hide();
            return;
        }
        if (this.completed === last) { return; }
        this.clearTimer();
        this.completed = last;
        this.item.backgroundColor = undefined;
        const failed = last.status === StatusCode.Error;
        const status = failed ? 'failed' : last.status === StatusCode.Cancelled ? 'cancelled' : 'completed';
        this.item.text = `$(${failed ? 'warning' : last.status === StatusCode.Cancelled ? 'circle-slash' : 'check'}) BSP: ${last.title} ${status}`;
        this.item.tooltip = `${last.title}: ${status}\n${last.message ?? ''}\n\nClick to open BSP build output.`;
        if (failed) { this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); }
        this.item.show();
        if (!failed) { this.timer = setTimeout(() => { this.item.hide(); this.timer = undefined; }, 5000); }
    }

    private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

    dispose(): void {
        this.clearTimer();
        this.subscriptions.forEach(s => s.dispose());
        this.item.dispose();
    }
}
