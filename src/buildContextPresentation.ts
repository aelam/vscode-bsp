import type { ContextOption } from './buildContext';

const destinationKinds: Record<string, string> = {
    host: 'Host', device: 'Device', simulator: 'Simulator', emulator: 'Emulator',
    remote: 'Remote', container: 'Container', generic: 'Generic'
};

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : undefined;
}

export function destinationDetail(option: ContextOption): string | undefined {
    if (option.dataKind !== 'execution-destination') { return undefined; }
    const data = record(option.data), kind = text(data?.kind);
    if (!data || !kind || !Object.prototype.hasOwnProperty.call(destinationKinds, kind)) { return undefined; }
    const platform = record(data.platform);
    const platformLabel = text(platform?.id) ? text(platform?.label) : undefined;
    const version = text(data.osVersion), architecture = text(data.architecture), state = text(data.state);
    return [platformLabel ? [platformLabel, version].filter(Boolean).join(' ') : version ? `OS ${version}` : undefined,
        destinationKinds[kind], architecture, state ? `State: ${state}` : undefined].filter(Boolean).join(' · ');
}

export function contextOptionDetail(option: ContextOption): string | undefined {
    const reason = text(option.reason) ?? (option.availability === false ? 'Unavailable' : undefined);
    return [destinationDetail(option), reason].filter(Boolean).join('\n') || undefined;
}

export function contextOptionTooltip(option?: ContextOption): string | undefined {
    if (!option) { return undefined; }
    return [text(option.description), contextOptionDetail(option)].filter(Boolean).join('\n') || undefined;
}
