import * as vscode from 'vscode';
import * as path from 'path';
import { BuildTarget, BuildTargetIdentifier, SourcesItem } from './bspTypes';
import { logError } from './logger';

interface NavigateFolderItem {
    label?: string | vscode.TreeItemLabel;
    buildTarget?: BuildTarget;
    dependency?: BuildTargetIdentifier;
}

interface FolderSourcesClient {
    readonly connected: boolean;
    getSources(targets: Pick<BuildTarget, 'id'>[]): Promise<SourcesItem[]>;
}

interface FolderCandidate {
    uri: vscode.Uri;
    parentsToTry: number;
    label?: string;
    detail?: string;
    exactDirectory?: boolean;
}

interface FolderPickItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
}

function uriFromBspValue(value: string, allowTargetUri = true): vscode.Uri | undefined {
    const trimmed = value.trim();
    if (!trimmed) { return undefined; }

    if (path.isAbsolute(trimmed)) {
        return vscode.Uri.file(path.resolve(trimmed));
    }

    try {
        const uri = vscode.Uri.parse(trimmed);
        if (uri.scheme === 'file') {
            return vscode.Uri.file(path.resolve(uri.fsPath));
        }
        if (allowTargetUri && uri.path.startsWith('/')) {
            return vscode.Uri.file(uri.path);
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function projectPathFromUriPath(uriPath: string): string | undefined {
    for (const extension of ['.xcodeproj', '.xcworkspace']) {
        const index = uriPath.indexOf(extension);
        if (index >= 0) {
            return uriPath.slice(0, index + extension.length);
        }
    }
    return undefined;
}

function getNavigateFolderCandidates(item: NavigateFolderItem): FolderCandidate[] {
    const candidates: FolderCandidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (value: string | undefined, parentsToTry: number, label?: string) => {
        if (!value) { return; }
        const uri = uriFromBspValue(value);
        if (!uri || seen.has(uri.toString())) { return; }
        candidates.push({ uri, parentsToTry, label });
        seen.add(uri.toString());
    };
    const addProjectCandidates = (value: string | undefined) => {
        if (!value) { return; }
        let uriPath: string | undefined;
        try {
            const uri = vscode.Uri.parse(value.trim());
            uriPath = uri.path;
        } catch {
            uriPath = value;
        }

        const projectPath = projectPathFromUriPath(uriPath);
        if (!projectPath) { return; }
        addCandidate(path.dirname(projectPath), 0, 'Project Folder');
        addCandidate(projectPath, 0, 'Xcode Project');
    };

    addCandidate(item.buildTarget?.baseDirectory, 0);
    addProjectCandidates(item.buildTarget?.id.uri);
    addCandidate(item.buildTarget?.id.uri, 3);
    addProjectCandidates(item.dependency?.uri);
    addCandidate(item.dependency?.uri, 3);

    return candidates;
}

async function getSourceFolderCandidates(item: NavigateFolderItem, client?: FolderSourcesClient): Promise<FolderCandidate[]> {
    const target = item.buildTarget ?? (item.dependency ? { id: item.dependency } : undefined);
    if (!target || !client?.connected) { return []; }

    try {
        const items = (await client.getSources([target])).filter(entry => entry.target.uri === target.id.uri);
        const roots: FolderCandidate[] = [], sources: FolderCandidate[] = [], generated: FolderCandidate[] = [];
        const add = (list: FolderCandidate[], value: string, kind: number, detail: string) => {
            const uri = uriFromBspValue(value, false);
            if (!uri || (kind !== 1 && kind !== 2)) { return; }
            list.push({
                uri: kind === 1 ? vscode.Uri.file(path.dirname(uri.fsPath)) : uri,
                parentsToTry: 0, exactDirectory: true, detail
            });
        };
        for (const entry of items) {
            for (const root of entry.roots ?? []) { add(roots, root, 2, 'Source root'); }
            for (const source of entry.sources) {
                add(source.generated ? generated : sources, source.uri, source.kind,
                    source.generated ? 'Generated sources' : 'Source folder');
            }
        }
        return [roots, sources, generated].flatMap(group => group.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath)));
    } catch (error) {
        logError('Failed to get target sources for folder navigation', error);
        return [];
    }
}

async function getExistingFolderUri(candidate: FolderCandidate): Promise<vscode.Uri | undefined> {
    let uri = candidate.uri;
    let parentsRemaining = candidate.parentsToTry;

    while (true) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.Directory) !== 0) {
                return uri;
            }
            if (candidate.exactDirectory) { return undefined; }

            const parentPath = path.dirname(uri.fsPath);
            return parentPath === uri.fsPath ? uri : vscode.Uri.file(parentPath);
        } catch (error: any) {
            if (error.code !== 'FileNotFound' || parentsRemaining <= 0) {
                return undefined;
            }
        }

        const parentPath = path.dirname(uri.fsPath);
        if (parentPath === uri.fsPath) {
            return undefined;
        }

        uri = vscode.Uri.file(parentPath);
        parentsRemaining--;
    }
}

function getNavigateItemLabel(item: NavigateFolderItem): string {
    if (item.buildTarget) {
        return item.buildTarget.displayName || item.buildTarget.id.uri;
    }
    if (item.dependency) {
        return item.dependency.uri;
    }
    if (typeof item.label === 'string') {
        return item.label;
    }
    return 'selected item';
}

export async function navigateToTargetFolder(item?: NavigateFolderItem, client?: FolderSourcesClient): Promise<void> {
    if (!item) { return; }

    const folders: FolderPickItem[] = [];
    const seen = new Set<string>();
    const candidates = new Map<string, FolderCandidate>();
    for (const candidate of [...await getSourceFolderCandidates(item, client), ...getNavigateFolderCandidates(item)]) {
        const key = candidate.uri.toString();
        if (!candidates.has(key)) { candidates.set(key, candidate); }
    }
    for (const candidate of candidates.values()) {
        const folderUri = await getExistingFolderUri(candidate);
        if (folderUri && !seen.has(folderUri.toString())) {
            folders.push({
                label: candidate.label ?? (path.basename(folderUri.fsPath) || folderUri.fsPath),
                description: folderUri.fsPath,
                detail: candidate.detail,
                uri: folderUri
            });
            seen.add(folderUri.toString());
        }
    }

    if (folders.length === 1) {
        await vscode.commands.executeCommand('revealInExplorer', folders[0].uri);
        return;
    }

    if (folders.length > 1) {
        const selected = await vscode.window.showQuickPick(folders, {
            title: `Folders for ${getNavigateItemLabel(item)}`,
            placeHolder: 'Select a source or project folder to reveal in Explorer',
            matchOnDescription: true
        });
        if (selected) {
            await vscode.commands.executeCommand('revealInExplorer', selected.uri);
        }
        return;
    }

    vscode.window.showInformationMessage(
        `Could not find a folder for "${getNavigateItemLabel(item)}". No existing source or project directory was found.`
    );
}
