import * as vscode from 'vscode';
import { BuildTarget, BuildSystemData, DynamicSelectorResponse, SelectorOption } from './bspTypes';
import { TargetManager } from './targetManager';
import { logInfo, logError } from './logger';

/**
 * Generic target manager that can handle any build system using the standard BuildSystemData structure
 */
export class GenericTargetManager implements TargetManager {
    private buildData = new Map<string, BuildSystemData>();
    private _onDidChangeConfiguration = new vscode.EventEmitter<string>();
    readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    private context?: vscode.ExtensionContext;
    public readonly instanceId: string;
    
    constructor(
        private buildSystemName: string,
        private dataKind: string,
        context?: vscode.ExtensionContext
    ) {
        this.context = context;
        this.instanceId = `${buildSystemName}TargetManager-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        logInfo(`🆔 ${buildSystemName}TargetManager created with instance ID: ${this.instanceId}`);
    }

    canHandle(target: BuildTarget): boolean {
        // Generic manager can handle any target with selectors data
        if (this.buildSystemName === 'Generic') {
            return target.data && target.data.selectors && Array.isArray(target.data.selectors);
        }
        
        return target.dataKind === this.dataKind || (target.data && target.data[this.buildSystemName.toLowerCase()]);
    }

    extractCustomData(target: BuildTarget): BuildSystemData | null {
        logInfo(`🔍 [${this.instanceId}] extractCustomData called for target: ${target.id.uri}`);
        
        if (!this.canHandle(target)) {
            logInfo(`❌ [${this.instanceId}] Target ${target.id.uri} is not a ${this.buildSystemName} target`);
            return null;
        }

        try {
            let buildData: BuildSystemData;
            
            if (target.data && target.data.selectors) {
                // Direct server data structure support
                buildData = {
                    selectors: target.data.selectors,
                    selectedValues: {}
                };
                logInfo(`✅ [${this.instanceId}] Using direct server selectors data with ${target.data.selectors.length} selectors`);
            } else {
                logInfo(`❌ [${this.instanceId}] No selectors data found for target: ${target.id.uri}`);
                return null;
            }

            this.buildData.set(target.id.uri, buildData);
            this.loadBuildSettings(target.id.uri);
            
            return buildData;
        } catch (error) {
            logError(`Failed to extract ${this.buildSystemName} data for ${target.displayName}`, error);
            return null;
        }
    }


    async getCompileArguments(targetId: string): Promise<string[]> {
        return this.buildArguments(targetId, 'build');
    }

    async getTestArguments(targetId: string): Promise<string[]> {
        return this.buildArguments(targetId, 'test');
    }

    async getRunArguments(targetId: string): Promise<string[]> {
        return this.buildArguments(targetId, 'run');
    }

    private buildArguments(targetId: string, _action: 'build' | 'test' | 'run'): string[] {
        const buildData = this.buildData.get(targetId);
        if (!buildData || !buildData.selectedValues) {
            return [];
        }

        const args: string[] = [];
        
        // Use selectedValues structure
        for (const [_selectorKey, selectedValue] of Object.entries(buildData.selectedValues)) {
            if (selectedValue && selectedValue.arguments) {
                args.push(...selectedValue.arguments);
            }
        }

        return args;
    }

    async getDynamicSelectors(targetId: string): Promise<DynamicSelectorResponse | undefined> {
        const buildData = this.buildData.get(targetId);
        if (!buildData || !buildData.selectors) {
            return undefined;
        }

        return { selectors: buildData.selectors };
    }

    async handleDynamicSelection(targetId: string, selectorKey: string, selectedValue: SelectorOption): Promise<void> {
        const buildData = this.buildData.get(targetId);
        if (!buildData) {
            return;
        }

        // Initialize selectedValues if it doesn't exist
        if (!buildData.selectedValues) {
            buildData.selectedValues = {};
        }

        // Store the selected value for this selector
        buildData.selectedValues[selectorKey] = selectedValue;

        await this.saveBuildSettings(targetId);
        this._onDidChangeConfiguration.fire(targetId);
        
        logInfo(`Dynamic selection updated for ${targetId}: ${selectorKey} = ${selectedValue.displayName} (${JSON.stringify(selectedValue.arguments)})`);
    }

    getBuildSettingsDescription(targetId: string): string {
        const buildData = this.buildData.get(targetId);
        if (!buildData || !buildData.selectedValues) {
            return '';
        }

        const parts = [];
        
        for (const [_selectorKey, selectedValue] of Object.entries(buildData.selectedValues)) {
            if (selectedValue) {
                parts.push(selectedValue.displayName);
            }
        }

        return parts.join(' | ');
    }

    async saveBuildSettings(targetId: string): Promise<void> {
        const buildData = this.buildData.get(targetId);
        if (!buildData) {
            return;
        }

        try {
            const storageKey = `bsp.${this.buildSystemName.toLowerCase()}.targets`;
            
            if (this.context) {
                const savedConfigs = this.context.workspaceState.get<{[key: string]: any}>(storageKey) || {};
                
                savedConfigs[targetId] = {
                    selectedValues: buildData.selectedValues,
                    lastUpdated: new Date().toISOString()
                };

                await this.context.workspaceState.update(storageKey, savedConfigs);
                logInfo(`Saved ${this.buildSystemName} configuration for ${targetId} using extension context`);
            } else {
                const config = vscode.workspace.getConfiguration(`bsp.${this.buildSystemName.toLowerCase()}`);
                const savedConfigs = config.get<{[key: string]: any}>('targets') || {};
                
                savedConfigs[targetId] = {
                    selectedValues: buildData.selectedValues,
                    lastUpdated: new Date().toISOString()
                };

                await config.update('targets', savedConfigs, vscode.ConfigurationTarget.Workspace);
                logInfo(`Saved ${this.buildSystemName} configuration for ${targetId} using workspace config`);
            }
        } catch (error) {
            logError(`Failed to save ${this.buildSystemName} configuration for ${targetId}`, error);
        }
    }

    loadBuildSettings(targetId: string): void {
        let savedConfigs: {[key: string]: any} = {};
        const storageKey = `bsp.${this.buildSystemName.toLowerCase()}.targets`;
        
        try {
            if (this.context) {
                savedConfigs = this.context.workspaceState.get<{[key: string]: any}>(storageKey) || {};
            } else {
                const config = vscode.workspace.getConfiguration(`bsp.${this.buildSystemName.toLowerCase()}`);
                savedConfigs = config.get<{[key: string]: any}>('targets') || {};
            }
        } catch (error) {
            logError(`Failed to load ${this.buildSystemName} configuration for ${targetId}`, error);
            savedConfigs = {};
        }
        
        const savedConfig = savedConfigs[targetId];
        const buildData = this.buildData.get(targetId);
        if (buildData) {
            if (savedConfig) {
                buildData.selectedValues = savedConfig.selectedValues || {};
                logInfo(`Loaded saved ${this.buildSystemName} configuration for ${targetId}`);
            } else {
                buildData.selectedValues = {};
                logInfo(`Set default ${this.buildSystemName} configuration for ${targetId}`);
            }
        }
    }
}