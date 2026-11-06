import { promises as fs } from 'fs';
import * as path from 'path';

const sourcekitLanguages = new Set(['swift', 'c', 'cpp', 'objective-c', 'objective-cpp']);

function isBuildServerConfig(value: unknown): value is { languages: string[] } {
    if (!value || typeof value !== 'object') { return false; }
    const config = value as Record<string, unknown>;
    return typeof config.name === 'string' && typeof config.version === 'string' && typeof config.bspVersion === 'string'
        && Array.isArray(config.languages) && config.languages.every(language => typeof language === 'string')
        && Array.isArray(config.argv) && config.argv.every(argument => typeof argument === 'string');
}

export async function validateSourcekitBspConfig(root: string, selectedPath: string): Promise<void> {
    const directory = path.join(root, '.bsp');
    const candidates: string[] = [];
    // SourceKit-LSP decodes every directory entry, including files without a .json suffix.
    for (const name of await fs.readdir(directory)) {
        try {
            const config: unknown = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
            if (isBuildServerConfig(config) && config.languages.some(language => sourcekitLanguages.has(language))) {
                candidates.push(path.resolve(directory, name));
            }
        } catch { /* SourceKit-LSP also skips unreadable configurations. */ }
    }
    if (candidates.length > 1) {
        throw new Error('Swift test discovery is ambiguous: multiple Swift/C-family BSP configurations share this workspace. SourceKit-LSP cannot select this connection.');
    }
    if (candidates.length !== 1 || !selectedPath || candidates[0] !== path.resolve(selectedPath)) {
        throw new Error('Swift test discovery requires one Swift/C-family BSP configuration matching this connection');
    }
}
