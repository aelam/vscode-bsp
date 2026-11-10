import * as vscode from 'vscode';
import { findExecutable } from './serverExecutable';

interface ServerDefinition {
    label: string;
    homepage: string;
    setup: string;
    executable?: string;
    command?: string;
}

interface ServerItem extends vscode.QuickPickItem {
    server: ServerDefinition;
}

const servers: ServerDefinition[] = [
    {
        label: 'SourceKit BSP', homepage: 'https://github.com/aelam/sourcekit-bsp',
        setup: 'Swift and Xcode C-family projects. Install with Mint: mint install aelam/sourcekit-bsp',
        executable: 'sourcekit-bsp', command: 'mint install aelam/sourcekit-bsp'
    },
    {
        label: 'Bazel BSP (archived)', homepage: 'https://github.com/JetBrains/bazel-bsp',
        setup: 'This standalone BSP repository is archived. See its homepage for the successor project.'
    },
    {
        label: 'Bloop', homepage: 'https://scalacenter.github.io/bloop/',
        setup: 'Scala build server. Follow the Bloop installation guide.', executable: 'bloop'
    },
    {
        label: 'sbt', homepage: 'https://www.scala-sbt.org/1.x/docs/Build-Server-Protocol.html',
        setup: 'Scala and Java. Install sbt to use its built-in BSP server.', executable: 'sbt'
    },
    {
        label: 'Mill', homepage: 'https://mill-build.org/',
        setup: 'Scala, Java, and Kotlin. Install Mill to use its built-in BSP server.', executable: 'mill'
    },
    {
        label: 'Build Server for Gradle', homepage: 'https://github.com/microsoft/build-server-for-gradle',
        setup: 'Java and Scala, with initial Android Java support. Build the server from its source repository.'
    }
];

async function serverItems(linkButton: vscode.QuickInputButton): Promise<ServerItem[]> {
    return Promise.all(servers.map(async server => {
        const found = server.executable ? await findExecutable(server.executable) : undefined;
        return {
            server,
            label: server.label,
            description: found ? 'Found on PATH' : server.executable ? 'Not found on PATH' : 'Status unavailable',
            detail: server.setup,
            buttons: [linkButton]
        };
    }));
}

export function registerServerCatalog(): vscode.Disposable {
    return vscode.commands.registerCommand('bsp.browseServers', async () => {
        const linkButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open homepage' };
        const picker = vscode.window.createQuickPick<ServerItem>();
        picker.title = 'BSP Servers';
        picker.placeholder = 'Browse setup options and installed server commands';
        picker.items = await serverItems(linkButton);
        picker.onDidTriggerItemButton(event => {
            void vscode.env.openExternal(vscode.Uri.parse(event.item.server.homepage));
        });
        picker.onDidAccept(() => {
            const item = picker.selectedItems[0];
            picker.hide();
            if (!item) { return; }
            void (async () => {
                const copy = item.server.command ? 'Copy Command' : undefined;
                const choice = await vscode.window.showInformationMessage(
                    item.server.setup, ...(copy ? [copy, 'Open Homepage'] : ['Open Homepage'])
                );
                if (choice === copy && item.server.command) {
                    await vscode.env.clipboard.writeText(item.server.command);
                } else if (choice === 'Open Homepage') {
                    await vscode.env.openExternal(vscode.Uri.parse(item.server.homepage));
                }
            })();
        });
        picker.onDidHide(() => picker.dispose());
        picker.show();
    });
}
