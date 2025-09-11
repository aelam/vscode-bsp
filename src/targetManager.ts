import * as vscode from 'vscode';
import { BuildTarget, DynamicSelectorResponse } from './bspTypes';

/**
 * Abstract interface for managing build system specific data and operations
 */
export interface TargetManager {
    /**
     * Unique identifier for this manager instance
     */
    readonly instanceId: string;

    /**
     * Check if this manager can handle the given target
     */
    canHandle(target: BuildTarget): boolean;

    /**
     * Extract and cache custom data from the target
     */
    extractCustomData(target: BuildTarget): any | null;

    /**
     * Get compile arguments for the target based on user selections
     */
    getCompileArguments(targetId: string): Promise<string[]>;

    /**
     * Get test arguments for the target based on user selections
     */
    getTestArguments(targetId: string): Promise<string[]>;

    /**
     * Get run arguments for the target based on user selections
     */
    getRunArguments(targetId: string): Promise<string[]>;


    /**
     * Get dynamic selectors configuration for the target
     * Returns a list of available selectors with their options
     */
    getDynamicSelectors?(targetId: string): Promise<DynamicSelectorResponse | undefined>;

    /**
     * Handle dynamic selector selection
     * @param targetId The target identifier
     * @param selectorKey The selector key (e.g., 'configuration', 'destination')
     * @param selectedValue The selected option
     */
    handleDynamicSelection?(targetId: string, selectorKey: string, selectedValue: any): Promise<void>;

    /**
     * Get description of current build settings for display
     */
    getBuildSettingsDescription(targetId: string): string;

    /**
     * Save current build settings to persistent storage
     */
    saveBuildSettings(targetId: string): Promise<void>;

    /**
     * Load build settings from persistent storage
     */
    loadBuildSettings(targetId: string): void;

    /**
     * Event fired when configuration changes
     */
    readonly onDidChangeConfiguration: vscode.Event<string>;
}

/**
 * Registry for managing multiple target managers
 */
export class TargetManagerRegistry {
    private managers: TargetManager[] = [];

    register(manager: TargetManager): void {
        this.managers.push(manager);
    }

    unregister(manager: TargetManager): void {
        const index = this.managers.indexOf(manager);
        if (index >= 0) {
            this.managers.splice(index, 1);
        }
    }

    /**
     * Find the appropriate manager for a given target
     */
    getManagerForTarget(target: BuildTarget): TargetManager | undefined {
        return this.managers.find(manager => manager.canHandle(target));
    }

    /**
     * Get all registered managers
     */
    getAllManagers(): TargetManager[] {
        return [...this.managers];
    }
}