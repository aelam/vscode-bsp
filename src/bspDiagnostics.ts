import { Diagnostic, PublishDiagnosticsParams } from './bspTypes';

export class BspDiagnostics {
    private files = new Map<string, Map<string, Diagnostic[]>>();

    update(params: PublishDiagnosticsParams): Diagnostic[] {
        const uri = params.textDocument.uri;
        const targets = this.files.get(uri) ?? new Map<string, Diagnostic[]>();
        const previous = params.reset ? [] : targets.get(params.buildTarget.uri) ?? [];
        const current = [...previous, ...params.diagnostics];
        if (current.length) { targets.set(params.buildTarget.uri, current); }
        else { targets.delete(params.buildTarget.uri); }
        if (targets.size) { this.files.set(uri, targets); }
        else { this.files.delete(uri); }
        // A shared source file can receive the same diagnostic from several targets.
        const unique = new Map<string, Diagnostic>();
        for (const values of targets.values()) {
            for (const value of values) { unique.set(JSON.stringify(value), value); }
        }
        return [...unique.values()];
    }

    clear(): void { this.files.clear(); }
}
