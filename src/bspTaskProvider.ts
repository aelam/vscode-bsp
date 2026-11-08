import * as path from 'path';
import * as vscode from 'vscode';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { BspTargetOptions, BspTargetResolver, validateTargetOptions } from './bspTargetResolver';
import { StatusCode } from './bspTypes';

type TaskOperation = 'compile' | 'run' | 'test';
interface BspTaskDefinition extends vscode.TaskDefinition, BspTargetOptions {
    type: 'bsp';
    operation: TaskOperation;
    target: string;
}

function definition(value: vscode.TaskDefinition): BspTaskDefinition {
    if (value.type !== 'bsp' || !['compile', 'run', 'test'].includes(value.operation)) {
        throw new Error('BSP tasks support compile, run, and test operations.');
    }
    validateTargetOptions({ connection: value.connection, target: value.target, buildPolicy: value.buildPolicy }, value.operation);
    if (!value.target) { throw new Error('A BSP task requires a target URI or unique display name.'); }
    return value as BspTaskDefinition;
}

export class BspTaskProvider implements vscode.TaskProvider, vscode.Disposable {
    private terminals = new Set<BspTaskTerminal>();
    private disposed = false;

    constructor(private resolver: BspTargetResolver) {}

    async provideTasks(token: vscode.CancellationToken): Promise<vscode.Task[]> {
        if (token.isCancellationRequested || this.disposed) { return []; }
        const choices = await this.resolver.list(undefined, token);
        if (token.isCancellationRequested || this.disposed) { return []; }
        const tasks: vscode.Task[] = [];
        for (const choice of choices) {
            const folder = vscode.workspace.getWorkspaceFolder(choice.connection.config.workspaceUri);
            if (!folder) { continue; }
            const configPath = choice.connection.config.configPath;
            const connection = configPath ? path.relative(folder.uri.fsPath, configPath).split(path.sep).join('/') : undefined;
            for (const operation of ['compile', 'test', 'run'] as const) {
                if (!this.resolver.supports(choice, operation)) { continue; }
                const value: BspTaskDefinition = { type: 'bsp', operation, target: choice.target.id.uri,
                    ...(connection ? { connection } : {}) };
                const name = `${operation} ${choice.label} (${connection ?? choice.description})`;
                const task = new vscode.Task(value, folder, name, 'BSP', this.execution(folder), []);
                task.detail = choice.target.id.uri;
                if (operation === 'compile') { task.group = vscode.TaskGroup.Build; }
                if (operation === 'test') { task.group = vscode.TaskGroup.Test; }
                tasks.push(task);
            }
        }
        const names = new Map<string, number>();
        const key = (task: vscode.Task) => `${(task.scope as vscode.WorkspaceFolder).uri.toString()}\n${task.name}`;
        for (const task of tasks) { names.set(key(task), (names.get(key(task)) ?? 0) + 1); }
        for (const task of tasks) { if (names.get(key(task))! > 1) { task.name += ` · ${task.definition.target}`; } }
        return tasks;
    }

    resolveTask(task: vscode.Task, token: vscode.CancellationToken): vscode.Task | undefined {
        if (token.isCancellationRequested || this.disposed || task.definition.type !== 'bsp') { return undefined; }
        const folder = task.scope && typeof task.scope !== 'number' ? task.scope : undefined;
        task.execution = this.execution(folder, task.isBackground);
        return task;
    }

    private execution(folder?: vscode.WorkspaceFolder, background = false): vscode.CustomExecution {
        return new vscode.CustomExecution(async resolved => {
            const terminal: BspTaskTerminal = new BspTaskTerminal(async (token, output) => {
                if (this.disposed) { throw new Error('BSP task provider has stopped.'); }
                if (background) { throw new Error('BSP tasks cannot use isBackground: true.'); }
                const value = definition(resolved);
                const selected = await this.resolver.resolve(value, value.operation, folder, token);
                if (!selected || token.isCancellationRequested) { return StatusCode.Cancelled; }
                const { client } = selected.connection, { target } = selected;
                const options = { token, native: true, onOutput: output };
                output(`${value.operation}: ${target.displayName ?? target.id.uri}`);
                output('Full server output: Output > vscode-bsp-log');
                if (client.contexts.enabled) {
                    const result = await client.executeContext(value.operation, { targets: [target.id] }, token,
                        options, false, [target], value.buildPolicy ?? 'build');
                    if (!('statusCode' in result)) { throw new Error('The BSP server returned no task status.'); }
                    return result.statusCode;
                }
                if (value.operation === 'compile') { return (await client.compile(target, token, options)).statusCode; }
                if (client.supportsOperation('compile', target)) {
                    const built = await client.compile(target, token, options);
                    if (built.statusCode !== StatusCode.Ok) { return built.statusCode; }
                }
                if (token.isCancellationRequested) { return StatusCode.Cancelled; }
                return value.operation === 'test' ? (await client.test(target, options)).statusCode
                    : (await client.run(target, token, options)).statusCode;
            }, () => this.terminals.delete(terminal));
            this.terminals.add(terminal);
            return terminal;
        });
    }

    dispose(): void {
        this.disposed = true;
        for (const terminal of this.terminals) { terminal.close(); }
    }
}

class BspTaskTerminal implements vscode.Pseudoterminal {
    private writes = new vscode.EventEmitter<string>();
    private exits = new vscode.EventEmitter<number>();
    readonly onDidWrite = this.writes.event;
    readonly onDidClose = this.exits.event;
    private cancellation = new CancellationTokenSource();
    private opened = false;

    constructor(
        private execute: (token: vscode.CancellationToken, output: (message: string) => void) => Promise<StatusCode>,
        private finished: () => void
    ) {}

    open(): void {
        if (this.opened) { return; }
        this.opened = true;
        void this.run();
    }

    close(): void { this.cancellation.cancel(); }
    handleInput(data: string): void { if (data.includes('\x03')) { this.close(); } }

    private output(message: string): void { this.writes.fire(message.replace(/\r?\n/g, '\r\n') + '\r\n'); }

    private async run(): Promise<void> {
        let code = 1;
        try {
            const token = this.cancellation.token;
            const status = token.isCancellationRequested ? StatusCode.Cancelled
                : await this.execute(token, message => this.output(message));
            code = token.isCancellationRequested || status === StatusCode.Cancelled ? 130 : status === StatusCode.Ok ? 0 : 1;
            this.output(code === 0 ? 'Task completed.' : code === 130 ? 'Task cancelled.' : 'Task failed.');
        } catch (error) {
            code = this.cancellation.token.isCancellationRequested ? 130 : 1;
            this.output(code === 130 ? 'Task cancelled.' : `Task failed: ${String(error)}`);
        } finally {
            this.exits.fire(code);
            this.finished();
            this.cancellation.dispose();
            this.writes.dispose();
            this.exits.dispose();
        }
    }
}
