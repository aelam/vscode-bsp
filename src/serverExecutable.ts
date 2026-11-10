import * as fs from 'fs/promises';
import * as path from 'path';

export async function findExecutable(name: string, searchPath = process.env.PATH ?? ''): Promise<string | undefined> {
    for (const directory of searchPath.split(path.delimiter)) {
        if (!directory) { continue; }
        const candidate = path.join(directory, name);
        try {
            const stat = await fs.stat(candidate);
            if (!stat.isFile()) { continue; }
            await fs.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* Try the next directory. */ }
    }
    return undefined;
}
