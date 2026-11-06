import type { ContextOption } from './buildContext';

const destinationKinds: Record<string, string> = {
    host: 'Host', device: 'Device', simulator: 'Simulator', emulator: 'Emulator',
    remote: 'Remote', container: 'Container', generic: 'Generic'
};

const destinationIcons: Record<string, string> = {
    host: 'device-desktop', device: 'device-mobile', simulator: 'vm', emulator: 'vm',
    remote: 'remote', container: 'package', generic: 'layers'
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

function destinationIdentifier(option: ContextOption): string | undefined {
    if (option.dataKind !== 'execution-destination') { return undefined; }
    const identifier = record(record(option.data)?.identifier);
    const label = text(identifier?.label), value = text(identifier?.value);
    return label && value ? `${label}: ${value}` : undefined;
}

export function contextOptionDetail(option: ContextOption): string | undefined {
    const reason = text(option.reason) ?? (option.availability === false ? 'Unavailable' : undefined);
    return [destinationDetail(option), destinationIdentifier(option), reason].filter(Boolean).join('\n') || undefined;
}

export function contextOptionTooltip(option?: ContextOption): string | undefined {
    if (!option) { return undefined; }
    return [text(option.description), contextOptionDetail(option)].filter(Boolean).join('\n') || undefined;
}

export function contextOptionPresentation(option: ContextOption): {
    label: string; description?: string; detail?: string; icon?: string;
} {
    const data = option.dataKind === 'execution-destination' ? record(option.data) : undefined;
    const kind = text(data?.kind);
    if (!kind || !Object.prototype.hasOwnProperty.call(destinationKinds, kind)) {
        return { label: option.label, description: option.description, detail: contextOptionDetail(option) };
    }
    const label = option.label.toLocaleLowerCase();
    const platform = record(data?.platform);
    const platformLabel = text(platform?.id) ? text(platform?.label) : undefined;
    const metadata = [platformLabel, text(data?.osVersion), destinationKinds[kind], text(data?.architecture)]
        .filter((part): part is string => !!part && !label.includes(part.toLocaleLowerCase()));
    const reason = text(option.reason) ?? (option.availability === false ? 'Unavailable' : undefined);
    const state = text(data?.state);
    const description = text(option.description);
    const repeated = [option.label, ...metadata, metadata.join(' · '), destinationDetail(option),
        destinationIdentifier(option), state, state ? `State: ${state}` : undefined, reason]
        .filter(Boolean).map(value => value!.toLocaleLowerCase());
    const descriptionDetail = description && !repeated.includes(description.toLocaleLowerCase()) ? description : undefined;
    return {
        label: option.label,
        description: metadata.join(' · ') || undefined,
        detail: [destinationIdentifier(option), descriptionDetail, state ? `State: ${state}` : undefined, reason].filter(Boolean).join(' · ') || undefined,
        icon: destinationIcons[kind]
    };
}

export function contextOptionGroups(options: ContextOption[]): { label?: string; options: ContextOption[] }[] {
    const kind = (option: ContextOption): string | undefined => option.dataKind === 'execution-destination'
        ? text(record(option.data)?.kind) : undefined;
    if (!options.some(option => destinationDetail(option) !== undefined)) { return [{ options }]; }
    const groups = [
        { label: 'Devices', options: options.filter(option => ['device', 'host'].includes(kind(option) ?? '')) },
        { label: options.some(option => kind(option) === 'emulator') ? 'Simulators and emulators' : 'Simulators',
            options: options.filter(option => ['simulator', 'emulator'].includes(kind(option) ?? '')) },
        { label: 'Other destinations', options: options.filter(option =>
            !['device', 'host', 'simulator', 'emulator', 'generic'].includes(kind(option) ?? '')) },
        { label: 'Generic destinations', options: options.filter(option => kind(option) === 'generic') }
    ];
    return groups.filter(group => group.options.length > 0).map(group => ({ ...group, options: [
        ...group.options.filter(option => option.availability !== false),
        ...group.options.filter(option => option.availability === false)
    ] }));
}
