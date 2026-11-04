import * as vscode from 'vscode';
import type { TestCatalog } from './testDiscovery';
import { StatusCode, TaskFinishParams, TaskStartParams, TestStatus } from './bspTypes';
import { taskId } from './bspProgress';
import { testTaskMessage } from './bspTestReports';

interface CaseState { item: vscode.TestItem; startTime?: number; finished: boolean }

const outputStyles = {
    passed: { color: 32, marker: '✓' },
    failed: { color: 31, marker: '✗' },
    warning: { color: 33, marker: '○' },
    progress: { color: 36, marker: '▶' }
};
type OutputStyle = keyof typeof outputStyles;

// One BSP request can contain nested tasks; only test payloads change test results.
export class BspTestRun {
    private cases = new Map<string, CaseState>();
    private occurrences = new Map<string, number>();
    private failed = false;
    private incomplete = false;
    private report?: { failed: number; total: number; time?: number };
    private ended = false;
    private unrelatedTasks = new Set<string>();

    constructor(
        private controller: vscode.TestController,
        readonly run: vscode.TestRun,
        readonly target: vscode.TestItem,
        readonly targetUri: string,
        private catalog?: TestCatalog
    ) { run.started(target); }

    start(params: TaskStartParams): void {
        if (this.ended || this.unrelated(params)) { return; }
        if (params.dataKind === 'test-start') {
            this.testCase(params);
        }
    }

    finishTask(params: TaskFinishParams): void {
        if (this.ended || this.unrelated(params)) { return; }
        const data = object(params.data);
        if (params.dataKind === 'test-report' && data && testTaskMessage(params)) {
            if (object(data.target)?.uri !== this.targetUri) { return; }
            const total = ['passed', 'failed', 'ignored', 'cancelled', 'skipped']
                .reduce((sum, key) => sum + (data[key] as number), 0);
            this.report = { failed: data.failed as number, total, time: finiteTime(data.time) };
            const style: OutputStyle = params.status === StatusCode.Error || (data.failed as number) > 0 ? 'failed'
                : params.status === StatusCode.Cancelled || (data.cancelled as number) > 0 || !(data.passed as number)
                    ? 'warning' : 'passed';
            this.output(testTaskMessage(params)!, this.target, style);
            return;
        }
        if (params.dataKind !== 'test-finish') { return; }
        const state = this.testCase(params);
        if (!state || state.finished) { return; }
        state.finished = true;
        const finishTime = finiteTime(params.eventTime);
        const duration = state.startTime !== undefined && finishTime !== undefined && finishTime >= state.startTime
            ? finishTime - state.startTime : undefined;
        const message = new vscode.TestMessage(typeof data?.message === 'string' ? data.message : 'Test failed');
        message.location = testLocation(data?.location)
            ?? (state.item.uri && state.item.range ? new vscode.Location(state.item.uri, state.item.range) : undefined);
        switch (data?.status) {
            case TestStatus.Passed: this.run.passed(state.item, duration); break;
            case TestStatus.Failed:
                this.failed = true;
                this.run.failed(state.item, message, duration);
                break;
            case TestStatus.Ignored:
            case TestStatus.Skipped:
                this.run.skipped(state.item);
                break;
            case TestStatus.Cancelled:
                this.incomplete = true;
                this.run.skipped(state.item);
                break;
            default:
                this.incomplete = true;
                this.run.errored(state.item, new vscode.TestMessage('The server returned an unknown test status'));
        }
        const style: OutputStyle = data?.status === TestStatus.Passed ? 'passed'
            : [TestStatus.Ignored, TestStatus.Skipped, TestStatus.Cancelled].includes(data?.status as TestStatus)
                ? 'warning' : 'failed';
        this.output(testTaskMessage(params) ?? 'Invalid test result', state.item, style);
    }

    finish(status: StatusCode, error?: string): void {
        if (this.ended) { return; }
        this.ended = true;
        for (const state of this.cases.values()) {
            if (state.finished) { continue; }
            this.incomplete = true;
            if (status === StatusCode.Cancelled) { this.run.skipped(state.item); }
            else { this.run.errored(state.item, new vscode.TestMessage(error ?? 'No result was reported for this test')); }
        }
        const completed = new Set([...this.cases.values()].map(state => state.item.id));
        for (const item of this.catalog?.selected ?? []) {
            if (completed.has(item.id)) { continue; }
            this.incomplete = true;
            if (status === StatusCode.Cancelled) { this.run.skipped(item); }
            else { this.run.errored(item, new vscode.TestMessage(error ?? 'No result was reported for the selected test')); }
        }
        const time = this.report?.time;
        if (status === StatusCode.Cancelled) {
            this.run.skipped(this.target);
            this.output('Test run cancelled', this.target, 'warning');
        } else if (this.failed || (this.report?.failed ?? 0) > 0) {
            this.run.failed(this.target, new vscode.TestMessage(error ?? 'One or more tests failed. See the test results.'), time);
        } else if (status !== StatusCode.Ok || this.incomplete) {
            this.run.errored(this.target, new vscode.TestMessage(error ?? 'The test request ended without complete results. See the output.'), time);
        } else {
            this.run.passed(this.target, time);
        }
        // Replace cached cases only when a complete target report accounts for every result.
        if (!this.catalog && status !== StatusCode.Cancelled && !this.incomplete && this.report?.total === this.cases.size) {
            this.target.children.replace([...this.cases.values()].map(state => state.item));
        }
        if (error) { this.output(error, this.target, status === StatusCode.Cancelled ? 'warning' : 'failed'); }
    }

    log(message: string, type?: number): void {
        const prefix = type === 1 ? 'Error: ' : type === 2 ? 'Warning: ' : '';
        this.output(prefix + message, this.target, type === 1 ? 'failed' : type === 2 ? 'warning' : undefined);
    }

    output(message: string, item: vscode.TestItem = this.target, style?: OutputStyle): void {
        const text = message.replace(/\r?\n/g, '\r\n');
        const decoration = style && outputStyles[style];
        const output = decoration ? `\u001b[${decoration.color}m${decoration.marker} ${text}\u001b[0m` : text;
        this.run.appendOutput(output + '\r\n', undefined, item);
    }

    private testCase(params: TaskStartParams): CaseState | undefined {
        const data = object(params.data);
        if (typeof data?.displayName !== 'string' || !data.displayName) { return undefined; }
        // A server can report several named test results on the target's task.
        const id = JSON.stringify([taskId(params.taskId), data.displayName]);
        const existing = this.cases.get(id);
        if (existing) { return existing; }
        const location = testLocation(data.location);
        const key = JSON.stringify([data.displayName, location?.uri.toString(), location?.range.start]);
        const occurrence = this.occurrences.get(key) ?? 0;
        this.occurrences.set(key, occurrence + 1);
        const itemId = JSON.stringify([this.target.id, key, occurrence]);
        const discovered = typeof data.testId === 'string' ? this.catalog?.items.get(data.testId) : undefined;
        const item = discovered ?? this.target.children.get(itemId)
            ?? this.controller.createTestItem(itemId, data.displayName, location?.uri);
        if (!discovered) {
            item.range = location?.range;
            item.description = 'Result from the last target run';
            item.tags = [];
            this.target.children.add(item);
        }
        if (this.catalog?.selected && !this.catalog.selected.some(selected => selected.id === item.id)) {
            this.incomplete = true;
            this.output('The server reported a test outside the selection', item, 'failed');
        }
        this.run.enqueued(item);
        this.run.started(item);
        const state = { item, startTime: params.dataKind === 'test-start' ? finiteTime(params.eventTime) : undefined, finished: false };
        this.cases.set(id, state);
        return state;
    }

    private unrelated(params: TaskStartParams): boolean {
        const id = taskId(params.taskId);
        const parents = typeof params.taskId === 'string' ? [] : params.taskId.parents ?? [];
        const target = params.dataKind === 'test-task' ? object(object(params.data)?.target)?.uri : undefined;
        if ((typeof target === 'string' && target !== this.targetUri)
            || parents.some(parent => this.unrelatedTasks.has(parent))) { this.unrelatedTasks.add(id); }
        return this.unrelatedTasks.has(id);
    }
}

export function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteTime(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function testLocation(value: unknown): vscode.Location | undefined {
    const data = object(value), range = object(data?.range);
    const start = object(range?.start), end = object(range?.end);
    if (typeof data?.uri !== 'string' || !start || !end) { return undefined; }
    if (![start.line, start.character, end.line, end.character]
        .every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) { return undefined; }
    if ((end.line as number) < (start.line as number)
        || (end.line === start.line && (end.character as number) < (start.character as number))) { return undefined; }
    try {
        return new vscode.Location(vscode.Uri.parse(data.uri), new vscode.Range(
            start.line as number, start.character as number, end.line as number, end.character as number
        ));
    } catch { return undefined; }
}
