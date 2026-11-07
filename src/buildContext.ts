import { CancellationToken } from 'vscode-jsonrpc/node';
import type { BuildTargetIdentifier } from './bspTypes';

export const buildContextExtension = 'vscode-bsp.build-context';
export const buildContextVersion = '0.1';
export type ContextOperation = 'compile' | 'run' | 'test' | 'debug';
export type ContextBuildPolicy = 'build' | 'reuse';
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
    buildPolicy?: ContextBuildPolicy;
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
    private reuseBuild = false;
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
    get supportsReuse(): boolean { return this.accepted && this.reuseBuild; }
    get operations(): readonly ContextOperation[] { return this.available; }

    negotiate(data: unknown): void {
        this.available = [];
        this.accepted = false;
        this.reuseBuild = false;
        const descriptor = object(object(object(data)?.bspExtensions)?.[buildContextExtension]);
        if (descriptor?.version !== buildContextVersion) { return; }
        if (descriptor.required !== true || !Array.isArray(descriptor.operations)
            || !descriptor.operations.every(op => contextOperations.includes(op as ContextOperation))
            || (descriptor.buildPolicies !== undefined && (!Array.isArray(descriptor.buildPolicies)
                || !descriptor.buildPolicies.includes('build')
                || !descriptor.buildPolicies.every(policy => policy === 'build' || policy === 'reuse')))) {
            throw new Error('The server returned an invalid build context capability');
        }
        this.available = [...new Set(descriptor.operations as ContextOperation[])];
        this.reuseBuild = Array.isArray(descriptor.buildPolicies) && descriptor.buildPolicies.includes('reuse');
        this.accepted = true;
    }

    disconnect(): void { this.available = []; this.accepted = false; this.reuseBuild = false; }

    requireBuildPolicy(operation: ContextOperation, policy: ContextBuildPolicy): void {
        this.require(operation);
        if (policy === 'build') { return; }
        if (policy !== 'reuse' || operation === 'compile') {
            throw new Error(`Build policy ${policy} is not supported for ${operation}`);
        }
        if (!this.supportsReuse) { throw new Error('This server does not support execution without building'); }
    }

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
        dimensions: ContextDimension[], operation?: ContextOperation, token = CancellationToken.None): Promise<ContextOptions> {
        const position = dimensions.findIndex(item => item.id === dimension);
        if (position < 0) { throw new Error('This configuration option is no longer available'); }
        const before = new Set(dimensions.slice(0, position).map(item => item.id));
        const known = new Set(dimensions.map(item => item.id));
        const key = this.key(scope, operation), shared = operation ? this.getSelection(scope) : {};
        const proposed: ContextPreferences = Object.fromEntries(Object.entries(this.preferences.get(key) ?? {})
            .filter(([id]) => known.has(id)));
        const previous = this.getSelection(scope, operation);
        delete proposed[dimension];
        if (option !== undefined) {
            Object.defineProperty(proposed, dimension, { value: option, enumerable: true, configurable: true });
        } else if (operation && Object.prototype.hasOwnProperty.call(shared, dimension)) { proposed[dimension] = null; }
        const candidates = this.combine(shared, proposed);
        const prefix = Object.fromEntries(Object.entries(candidates).filter(([id]) => before.has(id) || id === dimension));
        const checked = previous[dimension] === option
            ? { selection: candidates, options: await this.checkedOptions(scope, operation, candidates, token) }
            : await this.retainCompatible(scope, operation, prefix, candidates, new Set([dimension]), shared, proposed, token);
        const updates = new Map<string, ContextPreferences>([[key,
            this.explicitPreferences(shared, proposed, checked.selection, checked.options)]]);
        if (!operation) {
            await Promise.all(contextOperations.map(async op => {
                const overrideKey = this.key(scope, op), overrides = this.preferences.get(overrideKey);
                if (!this.available.includes(op) || !overrides || !Object.keys(overrides).length) { return; }
                const effective = this.combine(checked.selection, overrides);
                const first = checked.options.dimensions.findIndex(item => Object.prototype.hasOwnProperty.call(overrides, item.id));
                if (first < 0) { updates.set(overrideKey, {}); return; }
                const upstream = new Set(checked.options.dimensions.slice(0, first).map(item => item.id));
                const inheritedPrefix = Object.fromEntries(Object.entries(effective).filter(([id]) => upstream.has(id)));
                const validated = await this.retainCompatible(scope, op, inheritedPrefix, effective, new Set(),
                    checked.selection, overrides, token);
                updates.set(overrideKey, this.explicitPreferences(checked.selection, overrides, validated.selection, validated.options));
            }));
        }
        if (token.isCancellationRequested) { throw new Error('Configuration selection cancelled'); }
        const old = new Map([...updates.keys()].map(id => [id, this.preferences.get(id)]));
        for (const [id, value] of updates) { this.preferences.set(id, value); }
        try { await this.save(); }
        catch (error) {
            for (const [id, value] of old) {
                if (this.preferences.get(id) !== updates.get(id)) { continue; }
                if (value) { this.preferences.set(id, value); } else { this.preferences.delete(id); }
            }
            throw error;
        }
        return checked.options;
    }

    private combine(shared: ContextSelection, explicit: ContextPreferences): ContextSelection {
        return Object.fromEntries(Object.entries({ ...shared, ...explicit })
            .filter((entry): entry is [string, string] => entry[1] !== null));
    }

    private availableOption(options: ContextOptions, id: string, value: string): boolean {
        const dimension = options.dimensions.find(item => item.id === id);
        return dimension?.kind === 'enum' && dimension.enabled !== false
            && dimension.options.some(option => option.id === value && option.availability !== false);
    }

    private async checkedOptions(scope: ContextScope, operation: ContextOperation | undefined,
        value: ContextSelection, token: CancellationToken): Promise<ContextOptions> {
        const options = await this.options(scope, operation, value, token);
        if (token.isCancellationRequested) { throw new Error('Configuration selection cancelled'); }
        for (const [id, selected] of Object.entries(value)) {
            if (this.availableOption(options, id, selected)) { continue; }
            const dimension = options.dimensions.find(item => item.id === id);
            const option = dimension?.options.find(item => item.id === selected);
            throw new Error(option?.reason ?? dimension?.reason ?? `The selected ${dimension?.label ?? id} is unavailable`);
        }
        return options;
    }

    private async retainCompatible(scope: ContextScope, operation: ContextOperation | undefined,
        prefix: ContextSelection, candidates: ContextSelection, skipped: Set<string>, shared: ContextSelection,
        explicit: ContextPreferences, token: CancellationToken): Promise<{ selection: ContextSelection; options: ContextOptions }> {
        const selection = { ...prefix }, processed = new Set([...Object.keys(prefix), ...skipped]);
        let options = await this.checkedOptions(scope, operation, selection, token);
        while (true) {
            const dimension = options.dimensions.find(item => !processed.has(item.id)
                && Object.prototype.hasOwnProperty.call(candidates, item.id));
            if (!dimension) { break; }
            processed.add(dimension.id);
            let value = candidates[dimension.id];
            if (!this.availableOption(options, dimension.id, value)) {
                if (!Object.prototype.hasOwnProperty.call(explicit, dimension.id) || explicit[dimension.id] === null
                    || !Object.prototype.hasOwnProperty.call(shared, dimension.id)
                    || !this.availableOption(options, dimension.id, shared[dimension.id])) { continue; }
                value = shared[dimension.id];
            }
            Object.defineProperty(selection, dimension.id, { value, enumerable: true, configurable: true });
            options = await this.checkedOptions(scope, operation, selection, token);
        }
        return { selection, options };
    }

    private explicitPreferences(shared: ContextSelection, proposed: ContextPreferences,
        selected: ContextSelection, options: ContextOptions): ContextPreferences {
        const known = new Set(options.dimensions.map(item => item.id));
        const result: ContextPreferences = Object.fromEntries(Object.entries(proposed).filter(([id, value]) =>
            known.has(id) && (value === null || selected[id] === value)));
        for (const id of Object.keys(shared)) {
            if (!Object.prototype.hasOwnProperty.call(selected, id)) {
                Object.defineProperty(result, id, { value: null, enumerable: true, configurable: true });
            }
        }
        return result;
    }

    async reset(scope: ContextScope, operation?: ContextOperation): Promise<void> {
        this.preferences.delete(this.key(scope, operation));
        if (!operation) { for (const op of contextOperations) { this.preferences.delete(this.key(scope, op)); } }
        await this.save();
    }

    async executionOptions(scope: ContextScope, operation: ContextOperation, token = CancellationToken.None): Promise<{
        options: ContextOptions; selection: ContextSelection; sharedScope: ContextScope; sharedDimensions: string[];
    }> {
        this.require(operation);
        const value = this.getSelection(scope, operation);
        if (!scope.targets) {
            const options = await this.options(scope, operation, value, token);
            return { options, selection: value, sharedScope: scope, sharedDimensions: options.dimensions.map(item => item.id) };
        }
        const sharedScope: ContextScope = scope.workspaceUri ? { workspaceUri: scope.workspaceUri } : {};
        const shared = this.getSelection(sharedScope, operation);
        const [workspaceSchema, targetSchema] = await Promise.all([
            this.options(sharedScope, operation, {}, token), this.options(scope, operation, {}, token)
        ]);
        if (token.isCancellationRequested) { throw new Error('Build context resolution cancelled'); }
        const targetDimensions = new Set(targetSchema.dimensions.map(item => item.id));
        const sharedDimensions = workspaceSchema.dimensions.map(item => item.id).filter(id => targetDimensions.has(id));
        // Workspace choices own shared fields. Omitted values keep Automatic and clear old target overrides.
        for (const id of sharedDimensions) {
            delete value[id];
            if (Object.prototype.hasOwnProperty.call(shared, id)) {
                Object.defineProperty(value, id, { value: shared[id], enumerable: true, configurable: true });
            }
        }
        const options = await this.options(scope, operation, value, token);
        return { options, selection: value, sharedScope, sharedDimensions };
    }

    async resolve(scope: ContextScope, operation: ContextOperation,
        token = CancellationToken.None, buildPolicy: ContextBuildPolicy = 'build'): Promise<ResolvedContext> {
        this.requireBuildPolicy(operation, buildPolicy);
        const { options, selection: value } = await this.executionOptions(scope, operation, token);
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
        if (options.operations && !options.operations.includes(operation)) {
            throw new Error(`This configuration does not support ${operation}`);
        }
        if (token.isCancellationRequested) { throw new Error('Build context resolution cancelled'); }
        const result = await this.request<ResolvedContext>('workspace/resolveContext', {
            scope, operation, selection: value, ...(buildPolicy === 'reuse' ? { buildPolicy } : {})
        }, token);
        if (!result || typeof result.id !== 'string' || !result.id || result.operation !== operation
            || !selection(result.selection) || !Array.isArray(result.targets) || !result.targets.length
            || !result.targets.every(target => target && typeof target.uri === 'string' && target.uri)
            || new Set(result.targets.map(target => target.uri)).size !== result.targets.length
            || (operation === 'run' && result.targets.length !== 1)) {
            throw new Error('The server returned an invalid resolved build context');
        }
        if ((result.buildPolicy ?? 'build') !== buildPolicy || result.buildPolicy === null) {
            throw new Error('The resolved build context does not match the requested build policy');
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
