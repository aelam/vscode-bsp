import * as vscode from 'vscode';
import { basename } from 'path';
import { BuildTarget, OutputPathItem } from './bspTypes';

interface OutputPathsClient {
    getOutputPaths(target: BuildTarget): Promise<OutputPathItem[]>;
}

export async function revealBuildOutput(client: OutputPathsClient, target: BuildTarget): Promise<void> {
    const paths = await client.getOutputPaths(target);
    if (!paths.length) {
        vscode.window.showInformationMessage('The server returned no output paths for this target.');
        return;
    }
    const choices = paths.map(path => {
        const uri = vscode.Uri.parse(path.uri);
        return {
            label: `${path.kind === 2 ? '$(folder)' : '$(file)'} ${basename(uri.path) || uri.path}`,
            description: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
            uri
        };
    });
    const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
        title: `Build output: ${target.displayName || target.id.uri}`,
        placeHolder: 'Select an output location'
    });
    if (!selected) { return; }
    try {
        await vscode.workspace.fs.stat(selected.uri);
    } catch (error: any) {
        if (error.code === 'FileNotFound') {
            vscode.window.showInformationMessage(`Build output does not exist yet: ${selected.description}. Compile the target first.`);
            return;
        }
        throw error;
    }
    // Reveal artifacts without launching executables or application bundles.
    await vscode.commands.executeCommand('revealFileInOS', selected.uri);
}
