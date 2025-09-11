import * as vscode from 'vscode';
import { BuildTarget } from './bspTypes';
import { TargetManager, TargetManagerRegistry } from './targetManager';
import { GenericTargetManager } from './genericTargetManager';
import { logInfo, logError } from './logger';

/**
 * Unified manager that coordinates multiple target managers for different build systems
 */
export class BuildSystemManager {
    private registry = new TargetManagerRegistry();
    private _onDidChangeConfiguration = new vscode.EventEmitter<string>();
    readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    public readonly instanceId: string;

    constructor(private context?: vscode.ExtensionContext) {
        this.instanceId = `buildSystemManager-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        logInfo(`🆔 BuildSystemManager created with instance ID: ${this.instanceId}`);
        
        // Register default target managers
        this.registerDefaultManagers();
    }

    private registerDefaultManagers(): void {
        // Register generic target manager for any build system with selectors
        const genericManager = new GenericTargetManager('Generic', 'any', this.context);
        this.registry.register(genericManager);
        
        // Listen to configuration changes from all managers
        genericManager.onDidChangeConfiguration((targetId) => {
            this._onDidChangeConfiguration.fire(targetId);
        });
        
        logInfo(`Registered GenericTargetManager: ${genericManager.instanceId}`);
    }

    /**
     * Register a new target manager
     */
    registerTargetManager(manager: TargetManager): void {
        this.registry.register(manager);
        
        // Listen to configuration changes
        manager.onDidChangeConfiguration((targetId) => {
            this._onDidChangeConfiguration.fire(targetId);
        });
        
        logInfo(`Registered target manager: ${manager.instanceId}`);
    }

    /**
     * Check if any manager can handle the given target
     */
    canHandle(target: BuildTarget): boolean {
        return this.registry.getManagerForTarget(target) !== undefined;
    }

    /**
     * Extract custom data from target using appropriate manager
     */
    extractCustomData(target: BuildTarget): any | null {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager) {
            return null;
        }
        
        return manager.extractCustomData(target);
    }

    /**
     * Get compile arguments for target
     */
    async getCompileArguments(target: BuildTarget): Promise<string[]> {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager) {
            return [];
        }
        
        return manager.getCompileArguments(target.id.uri);
    }

    /**
     * Get test arguments for target
     */
    async getTestArguments(target: BuildTarget): Promise<string[]> {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager) {
            return [];
        }
        
        return manager.getTestArguments(target.id.uri);
    }

    /**
     * Get run arguments for target
     */
    async getRunArguments(target: BuildTarget): Promise<string[]> {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager) {
            return [];
        }
        
        return manager.getRunArguments(target.id.uri);
    }


    /**
     * Get dynamic selectors configuration for target
     */
    async getDynamicSelectors(target: BuildTarget): Promise<import('./bspTypes').DynamicSelectorResponse | undefined> {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager || !manager.getDynamicSelectors) {
            return undefined;
        }
        
        return manager.getDynamicSelectors(target.id.uri);
    }

    /**
     * Handle dynamic selector selection
     */
    async handleDynamicSelection(target: BuildTarget, selectorKey: string, selectedValue: any): Promise<void> {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager || !manager.handleDynamicSelection) {
            vscode.window.showWarningMessage('Dynamic selection not supported for this target type');
            return;
        }
        
        await manager.handleDynamicSelection(target.id.uri, selectorKey, selectedValue);
        
        // Fire configuration change event
        this._onDidChangeConfiguration.fire(target.id.uri);
    }

    /**
     * Show dynamic selector based on configuration
     */
    async showDynamicSelector(target: BuildTarget, selectorConfig: any): Promise<void> {
        if (!selectorConfig.values || selectorConfig.values.length === 0) {
            vscode.window.showWarningMessage('No options available for this selector');
            return;
        }

        // Create quick pick items from selector values
        interface QuickPickItemWithOption extends vscode.QuickPickItem {
            option: any;
        }
        
        const items: QuickPickItemWithOption[] = selectorConfig.values.map((option: any) => {
            const item: QuickPickItemWithOption = {
                label: option.displayName,
                detail: option.description,
                option: option
            };
            
            return item;
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: selectorConfig.displayLabel,
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected && selected.option) {
            await this.handleDynamicSelection(target, selectorConfig.keyName, selected.option);
        }
    }

    /**
     * Get build settings description for target
     */
    getBuildSettingsDescription(target: BuildTarget): string {
        const manager = this.registry.getManagerForTarget(target);
        if (!manager) {
            return '';
        }
        
        return manager.getBuildSettingsDescription(target.id.uri);
    }


    /**
     * Get the target manager for a specific target
     */
    getManagerForTarget(target: BuildTarget): TargetManager | undefined {
        return this.registry.getManagerForTarget(target);
    }

    /**
     * Get all registered managers
     */
    getAllManagers(): TargetManager[] {
        return this.registry.getAllManagers();
    }


    // Debug methods
    getDebugInfo(): { [managerId: string]: any } {
        const info: { [managerId: string]: any } = {};
        
        for (const manager of this.registry.getAllManagers()) {
            info[manager.instanceId] = {
                type: manager.constructor.name
            };
        }
        
        return info;
    }
}