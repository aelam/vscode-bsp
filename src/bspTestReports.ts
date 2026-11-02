import { TaskStartParams } from './bspTypes';

// Format standard BSP payloads without build-tool-specific log parsing.
export function testTaskMessage(params: TaskStartParams): string | undefined {
    const data = params.data;
    if (!isObject(data)) { return undefined; }
    if (params.dataKind === 'test-start' && typeof data.displayName === 'string') {
        return `Test: ${data.displayName}`;
    }
    if (params.dataKind === 'test-finish' && typeof data.displayName === 'string') {
        const states: Record<number, string> = { 1: 'passed', 2: 'failed', 3: 'ignored', 4: 'cancelled', 5: 'skipped' };
        const state = typeof data.status === 'number' ? states[data.status] : undefined;
        if (!state) { return undefined; }
        const detail = typeof data.message === 'string' && data.message ? `\n${data.message}` : '';
        return `${data.displayName}: ${state}${detail}`;
    }
    if (params.dataKind !== 'test-report' || !isObject(data.target) || typeof data.target.uri !== 'string') {
        return undefined;
    }
    const fields = ['passed', 'failed', 'ignored', 'cancelled', 'skipped'];
    if (!fields.every(key => typeof data[key] === 'number' && Number.isSafeInteger(data[key]) && (data[key] as number) >= 0)) {
        return undefined;
    }
    const counts = fields.map(key => `${data[key]} ${key}`).join(', ');
    const time = typeof data.time === 'number' && Number.isFinite(data.time) && data.time >= 0
        ? ` (${(data.time / 1000).toFixed(2)}s)` : '';
    return `Tests for ${data.target.uri}: ${counts}${time}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
