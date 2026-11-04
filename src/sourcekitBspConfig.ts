import { promises as fs } from 'fs';
import * as path from 'path';

const sourcekitLanguages = new Set(['swift', 'c', 'cpp', 'objective-c', 'objective-cpp']);

export async function validateSourcekitBspConfig(root: string, selectedPath: string): Promise<void> {
    const directory = path.join(root, '.bsp');
    const candidates: string[] = [];
    for (const name of await fs.readdir(directory)) {
        if (!name.endsWith('.json')) { continue; }
        try {
            const config = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
            if (Array.isArray(config?.languages) && config.languages.some((language: string) => sourcekitLanguages.has(language))) {
                candidates.push(path.resolve(directory, name));
            }
        } catch { /* SourceKit-LSP also skips unreadable configurations. */ }
    }
    if (candidates.length !== 1 || (selectedPath && candidates[0] !== path.resolve(selectedPath))) {
        throw new Error('Swift test discovery requires one Swift/C-family BSP configuration matching this connection');
    }
}
