import { CancellationToken } from 'vscode-jsonrpc/node';
import type { BuildTargetIdentifier } from './bspTypes';

export const buildContextExtension = 'vscode-bsp.build-context';
export const buildContextVersion = '0.1';
export type ContextOperation = 'compile' | 'run' | 'test' | 'debug';
export const contextOperations: ContextOperation[] = ['compile', 'run', 'test', 'debug'];
export interface ContextScope { workspaceUri?: string; targets?: BuildTargetIdentifier[] }
export type ContextSelection = Record<string, string>;
export interface ContextOptionsParams { scope?: ContextScope; selection?: ContextSelection }
type ContextPreferences = Record<string, string | null>;
export interface ContextOption {
    id: string; label: string; description?: string; reason?: string; availability?: boolean;
    dataKind?: string; data?: unknown;
}
export interface ContextDimension {
    id: string; label: string; kind: string; required: boolean; options: ContextOption[]; value?: string;
    enabled?: boolean; reason?: string;
}
export interface ContextOptions { dimensions: ContextDimension[]; selection: ContextSelection; operations?: ContextOperation[] }
export interface ResolvedContext {
    id: string; operation: ContextOperation; targets: BuildTargetIdentifier[]; selection: ContextSelection;
}
export type ContextRequest = <T>(method: string, params: unknown, token: CancellationToken) => Promise<T>;
export interface ContextPreferenceStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function selection(value: unknown): value is ContextSelection {
    const record = object(value);
    return !!record && Object.values(record).every(item => typeof item === 'string');
}

// Preferences belong to one client connection. Resolved contexts never enter this store.
export class BuildContexts {
    private accepted = false;
    private available: ContextOperation[] = [];
    private preferences = new Map<string, ContextPreferences>();
    private storage?: ContextPreferenceStorage;
    private storageKey?: string;
    private workspaceUri?: string;

    constructor(private request: ContextRequest) {}

    attachPreferences(storage: ContextPreferenceStorage | undefined, identity: string, workspaceUri: string): void {
        this.storage = storage;
        this.storageKey = `bsp.contextPreferences.v1:${identity}`;
        this.workspaceUri = workspaceUri;
        const saved = object(storage?.get(this.storageKey));
        if (saved) {
            for (const [key, value] of Object.entries(saved)) {
                const record = object(value);
                if (record && Object.values(record).every(item => item === null || typeof item === 'string')) {
                    this.preferences.set(key, { ...record } as ContextPreferences);
                }
            }
        }
    }

    get enabled(): boolean { return this.accepted; }
    get operations(): readonly ContextOperation[] { return this.available; }

    negotiate(data: unknown): void {
        this.available = [];
        this.accepted = false;
        const descriptor = object(object(object(data)?.bspExtensions)?.[buildContextExtension]);
        if (descriptor?.version !== buildContextVersion) { return; }
        if (descriptor.required !== true || !Array.isArray(descriptor.operations)
            || !descriptor.operations.every(op => contextOperations.includes(op as ContextOperation))) {
            throw new Error('The server returned an invalid build context capability');
        }
        this.available = [...new Set(descriptor.operations as ContextOperation[])];
        this.accepted = true;
    }

    disconnect(): void { this.available = []; this.accepted = false; }

    getSelection(scope: ContextScope, operation?: ContextOperation): ContextSelection {
        const value = { ...this.preferences.get(this.key(scope)),
            ...(operation ? this.preferences.get(this.key(scope, operation)) : {}) };
        return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== null));
    }

    setSelection(scope: ContextScope, operation: ContextOperation | undefined, value: ContextSelection): Promise<void> {
        this.preferences.set(this.key(scope, operation), { ...value });
        return this.save();
    }

    // The operation selects local overrides. The discovery request never contains it.
    async options(scope: ContextScope, preferenceOperation?: ContextOperation,
        value = this.getSelection(scope, preferenceOperation), token = CancellationToken.None): Promise<ContextOptions> {
        if (preferenceOperation) { this.require(preferenceOperation); }
        else if (!this.enabled) { throw new Error('This server does not support build contexts'); }
        const params: ContextOptionsParams = { scope, selection: { ...value } };
        const result = await this.request<ContextOptions>('workspace/contextOptions', params, token);
        if (!result || !selection(result.selection) || !Array.isArray(result.dimensions)
            || (result.operations !== undefined && (!Array.isArray(result.operations)
                || !result.operations.every(op => contextOperations.includes(op))))
            || !result.dimensions.every(d => d && typeof d.id === 'string' && typeof d.label === 'string'
                && typeof d.kind === 'string' && typeof d.required === 'boolean'
                && (d.kind !== 'enum' && d.options === undefined
                    || Array.isArray(d.options) && d.options.every(o => o && typeof o.id === 'string' && typeof o.label === 'string')))) {
            throw new Error('The server returned invalid build context options');
        }
        return { ...result, dimensions: result.dimensions.map(d => ({ ...d, options: d.options ?? [] })) };
    }

    async choose(scope: ContextScope, dimension: string, option: string | undefined,
        dimensions: ContextDimension[], operation?: ContextOperation, token = CancellationToken.None): Promise<void> {
        const position = dimensions.findIndex(item => item.id === dimension);
        if (position < 0) { throw new Error('This configuration option is no longer available'); }
        const before = new Set(dimensions.slice(0, position).map(item => item.id));
        const explicit = this.preferences.get(this.key(scope, operation)) ?? {};
        const value: ContextPreferences = Object.fromEntries(Object.entries(explicit).filter(([key]) => before.has(key)));
        const shared = this.getSelection(scope);
        if (operation) {
            for (const item of dimensions.slice(position)) {
                if (Object.prototype.hasOwnProperty.call(shared, item.id)) { value[item.id] = null; }
            }
        }
        if (option !== undefined) { Object.defineProperty(value, dimension, { value: option, enumerable: true, configurable: true }); }
        const combined = operation ? { ...shared, ...value } : value;
        const effective = Object.fromEntries(Object.entries(combined).filter((entry): entry is [string, string] => entry[1] !== null));
        await this.options(scope, operation, effective, token);
        if (token.isCancellationRequested) { throw new Error('Configuration selection cancelled'); }
        this.preferences.set(this.key(scope, operation), value);
        if (!operation) {
            // Shared choices invalidate dependent overrides in each operation.
            for (const op of contextOperations) {
                const key = this.key(scope, op), overrides = this.preferences.get(key);
                if (overrides) { this.preferences.set(key,
                    Object.fromEntries(Object.entries(overrides).filter(([id]) => before.has(id)))); }
            }
        }
        await this.save();
    }

    async reset(scope: ContextScope, operation?: ContextOperation): Promise<void> {
        this.preferences.delete(this.key(scope, operation));
        if (!operation) { for (const op of contextOperations) { this.preferences.delete(this.key(scope, op)); } }
        await this.save();
    }

    async resolve(scope: ContextScope, operation: ContextOperation,
        token = CancellationToken.None): Promise<ResolvedContext> {
        this.require(operation);
        const value = this.getSelection(scope, operation);
        const options = await this.options(scope, operation, value, token);
        for (const dimension of options.dimensions) {
            if (dimension.kind !== 'enum') {
                if (dimension.required || value[dimension.id] !== undefined) {
                    throw new Error(`Unsupported configuration type for ${dimension.label}: ${dimension.kind}`);
                }
                continue;
            }
            if (dimension.enabled === false) {
                if (dimension.required || value[dimension.id] !== undefined) {
                    throw new Error(dimension.reason ?? `${dimension.label} is unavailable`);
                }
                continue;
            }
            const selected = value[dimension.id] ?? options.selection[dimension.id] ?? dimension.value;
            if (selected === undefined) {
                if (dimension.required) { throw new Error(`Select ${dimension.label} before ${operation}`); }
                continue;
            }
            const option = dimension.options.find(option => option.id === selected);
            if (!option || option.availability === false) {
                throw new Error(option?.reason ?? `The selected ${dimension.label} is unavailable`);
            }
        }
        if (token.isCancellationRequested) { throw new Error('Build context resolution cancelled'); }
        const result = await this.request<ResolvedContext>('workspace/resolveContext', {
            scope, operation, selection: value
        }, token);
        if (!result || typeof result.id !== 'string' || !result.id || result.operation !== operation
            || !selection(result.selection) || !Array.isArray(result.targets) || !result.targets.length
            || !result.targets.every(target => target && typeof target.uri === 'string' && target.uri)
            || new Set(result.targets.map(target => target.uri)).size !== result.targets.length
            || (operation === 'run' && result.targets.length !== 1)) {
            throw new Error('The server returned an invalid resolved build context');
        }
        if (scope.targets && JSON.stringify(scope.targets.map(t => t.uri).sort())
            !== JSON.stringify(result.targets.map(t => t.uri).sort())) {
            throw new Error('The resolved build context does not match the requested targets');
        }
        if (token.isCancellationRequested) { throw new Error('Build context resolution cancelled'); }
        return result;
    }

    private require(operation: ContextOperation): void {
        if (!this.available.includes(operation)) { throw new Error(`This server does not support build contexts for ${operation}`); }
    }

    private save(): Promise<void> {
        return this.storage && this.storageKey
            ? Promise.resolve(this.storage.update(this.storageKey, Object.fromEntries(this.preferences))) : Promise.resolve();
    }

    private key(scope: ContextScope, operation?: ContextOperation): string {
        return JSON.stringify([scope.workspaceUri ?? this.workspaceUri ?? null,
            scope.targets?.map(target => target.uri).sort() ?? null, operation ?? null]);
    }
}
