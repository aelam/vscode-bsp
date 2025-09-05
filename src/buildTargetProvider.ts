import * as vscode from 'vscode';
import { BspClient } from './bspClient';
import { BuildTarget, BuildTargetIdentifier } from './bspTypes';

export class BuildTargetProvider implements vscode.TreeDataProvider<BuildTargetItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<BuildTargetItem | undefined | null | void> = new vscode.EventEmitter<BuildTargetItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BuildTargetItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private bspClient: BspClient) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BuildTargetItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BuildTargetItem): Promise<BuildTargetItem[]> {
        if (!this.bspClient.connected) {
            return [];
        }

        if (!element) {
            // Root level - show all build targets
            try {
                const targets = await this.bspClient.getBuildTargets();
                return targets.map(target => new BuildTargetItem(target, vscode.TreeItemCollapsibleState.Collapsed));
            } catch (error) {
                console.error('Error getting build targets:', error);
                vscode.window.showErrorMessage(`Failed to load build targets: ${error}`);
                return [];
            }
        } else {
            // Show target details and dependencies
            const children: BuildTargetItem[] = [];
            
            // Add capabilities as children
            if (element.buildTarget.capabilities.canCompile) {
                children.push(new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: 'Can Compile'
                    },
                    vscode.TreeItemCollapsibleState.None,
                    'capability'
                ));
            }
            
            if (element.buildTarget.capabilities.canTest) {
                children.push(new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: 'Can Test'
                    },
                    vscode.TreeItemCollapsibleState.None,
                    'capability'
                ));
            }
            
            if (element.buildTarget.capabilities.canRun) {
                children.push(new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: 'Can Run'
                    },
                    vscode.TreeItemCollapsibleState.None,
                    'capability'
                ));
            }

            if (element.buildTarget.capabilities.canDebug) {
                children.push(new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: 'Can Debug'
                    },
                    vscode.TreeItemCollapsibleState.None,
                    'capability'
                ));
            }

            // Add dependencies
            if (element.buildTarget.dependencies.length > 0) {
                const dependenciesItem = new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: `Dependencies (${element.buildTarget.dependencies.length})`
                    },
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'dependencies'
                );
                children.push(dependenciesItem);
            }

            // Add languages
            if (element.buildTarget.languageIds.length > 0) {
                const languagesItem = new BuildTargetItem(
                    {
                        ...element.buildTarget,
                        displayName: `Languages: ${element.buildTarget.languageIds.join(', ')}`
                    },
                    vscode.TreeItemCollapsibleState.None,
                    'languages'
                );
                children.push(languagesItem);
            }

            return children;
        }
    }
}

export class BuildTargetItem extends vscode.TreeItem {
    constructor(
        public readonly buildTarget: BuildTarget,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: string = 'buildTarget'
    ) {
        super(buildTarget.displayName || buildTarget.id.uri, collapsibleState);
        
        this.tooltip = this.buildTooltip();
        this.description = this.buildDescription();
        this.contextValue = this.buildContextValue();
        this.iconPath = this.getIcon();
        
        if (itemType === 'buildTarget') {
            this.id = buildTarget.id.uri;
        }
    }

    private buildTooltip(): string {
        const target = this.buildTarget;
        const lines = [
            `Target: ${target.displayName || target.id.uri}`,
            `URI: ${target.id.uri}`
        ];

        if (target.baseDirectory) {
            lines.push(`Base Directory: ${target.baseDirectory}`);
        }

        if (target.tags.length > 0) {
            lines.push(`Tags: ${target.tags.join(', ')}`);
        }

        if (target.languageIds.length > 0) {
            lines.push(`Languages: ${target.languageIds.join(', ')}`);
        }

        const capabilities = [];
        if (target.capabilities.canCompile) capabilities.push('Compile');
        if (target.capabilities.canTest) capabilities.push('Test');
        if (target.capabilities.canRun) capabilities.push('Run');
        if (target.capabilities.canDebug) capabilities.push('Debug');
        
        if (capabilities.length > 0) {
            lines.push(`Capabilities: ${capabilities.join(', ')}`);
        }

        if (target.dependencies.length > 0) {
            lines.push(`Dependencies: ${target.dependencies.length}`);
        }

        return lines.join('\n');
    }

    private buildDescription(): string {
        const target = this.buildTarget;
        
        if (this.itemType === 'capability') {
            return '';
        }
        
        if (this.itemType === 'dependencies') {
            return '';
        }
        
        if (this.itemType === 'languages') {
            return '';
        }

        const parts = [];
        
        if (target.tags.length > 0) {
            parts.push(`[${target.tags.join(', ')}]`);
        }

        if (target.languageIds.length > 0) {
            parts.push(target.languageIds.join(', '));
        }

        return parts.join(' ');
    }

    private buildContextValue(): string {
        const target = this.buildTarget;
        
        if (this.itemType !== 'buildTarget') {
            return this.itemType;
        }

        const contextValues = [];
        
        if (target.capabilities.canCompile) {
            contextValues.push('canCompile');
        }
        
        if (target.capabilities.canTest) {
            contextValues.push('canTest');
        }
        
        if (target.capabilities.canRun) {
            contextValues.push('canRun');
        }

        // Determine primary action based on tags and capabilities
        if (target.tags.includes('test') && target.capabilities.canTest) {
            return 'testTarget';
        } else if (target.tags.includes('application') && target.capabilities.canRun) {
            if (target.capabilities.canDebug) {
                return 'debugTarget';
            }
            return 'runTarget';
        } else if (target.capabilities.canCompile) {
            return 'buildTarget';
        }

        return 'buildTarget';
    }

    private getIcon(): vscode.ThemeIcon {
        const target = this.buildTarget;
        
        switch (this.itemType) {
            case 'capability':
                return new vscode.ThemeIcon('gear');
            case 'dependencies':
                return new vscode.ThemeIcon('references');
            case 'languages':
                return new vscode.ThemeIcon('code');
            default:
                // Build target icons based on type
                if (target.tags.includes('test')) {
                    return new vscode.ThemeIcon('beaker');
                } else if (target.tags.includes('application')) {
                    return new vscode.ThemeIcon('play');
                } else if (target.tags.includes('library')) {
                    return new vscode.ThemeIcon('library');
                } else {
                    return new vscode.ThemeIcon('package');
                }
        }
    }
}
