import * as vscode from 'vscode';
import { BuildTarget, XcodeTarget, XcodeDestination } from './bspTypes';
import { logInfo, logError } from './logger';

export class XcodeManager {
    private xcodeData = new Map<string, XcodeTarget>();
    private _onDidChangeConfiguration = new vscode.EventEmitter<string>();
    readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    private context?: vscode.ExtensionContext;

    constructor(context?: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * 检查构建目标是否是Xcode项目
     */
    isXcodeTarget(target: BuildTarget): boolean {
        return target.dataKind === 'sourceKit' || (target.data && target.data.xcode);
    }

    /**
     * 提取Xcode项目数据
     */
    extractXcodeData(target: BuildTarget): XcodeTarget | null {
        if (!this.isXcodeTarget(target)) {
            return null;
        }

        try {
            let xcodeData: XcodeTarget;
            
            if (target.data && target.data.xcode) {
                // 使用已存在的xcode数据，但确保格式正确
                xcodeData = target.data.xcode as XcodeTarget;
            } else {
                // 从BSP数据中提取Xcode信息
                xcodeData = {
                    configurations: target.data?.configurations || [],
                    destinations: target.data?.destinations || [],
                    selectedConfiguration: undefined,
                    selectedDestination: undefined,
                };
            }

            // 更新缓存并加载用户配置（无论数据来源）
            this.xcodeData.set(target.id.uri, xcodeData);
            this.loadConfiguration(target.id.uri);
            
            return xcodeData;
        } catch (error) {
            logError(`Failed to extract Xcode data for ${target.displayName}`, error);
            return null;
        }
    }

    /**
     * 显示configuration选择器
     */
    async selectConfiguration(targetId: string): Promise<string | undefined> {
        logInfo(`selectConfiguration called for targetId: ${targetId}`);
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            logError(`No Xcode data found for target: ${targetId}`);
            vscode.window.showErrorMessage('No Xcode data found for this target');
            return;
        }

        logInfo(`Found Xcode data with ${xcodeData.configurations.length} configurations: ${JSON.stringify(xcodeData.configurations)}`);
        
        if (!xcodeData.configurations || xcodeData.configurations.length === 0) {
            vscode.window.showWarningMessage('No configurations available for this target');
            return;
        }

        const items = xcodeData.configurations.map(config => ({
            label: config,
            description: 'Build Configuration',
            configuration: config
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Xcode Configuration',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            xcodeData.selectedConfiguration = selected.configuration;
            await this.saveConfiguration(targetId);
            this._onDidChangeConfiguration.fire(targetId);
            logInfo(`Selected configuration: ${selected.configuration} for target ${targetId}`);
            return selected.configuration;
        }

        return undefined;
    }

    /**
     * 显示destination选择器
     */
    async selectDestination(targetId: string): Promise<string | undefined> {
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            vscode.window.showErrorMessage('No Xcode data found for this target');
            return;
        }

        const items = xcodeData.destinations.map(dest => ({
            label: dest.name,
            description: `${dest.platform} ${dest.deviceType}`,
            detail: dest.osVersion ? `Version ${dest.osVersion}` : undefined,
            destination: dest
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Xcode Destination',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            xcodeData.selectedDestination = selected.destination;
            await this.saveConfiguration(targetId);
            this._onDidChangeConfiguration.fire(targetId);
            logInfo(`Selected destination: ${selected.destination.name} for target ${targetId}`);
            return selected.destination.id;
        }

        return undefined;
    }

    /**
     * 获取当前选择的configuration
     */
    getSelectedConfiguration(targetId: string): string | undefined {
        return this.xcodeData.get(targetId)?.selectedConfiguration;
    }

    /**
     * 获取当前选择的destination
     */
    getSelectedDestination(targetId: string): XcodeDestination | undefined {
        return this.xcodeData.get(targetId)?.selectedDestination;
    }

    /**
     * 获取Xcode配置描述
     */
    getConfigurationDescription(targetId: string): string {
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            return '';
        }

        const parts = [];
        
        if (xcodeData.selectedConfiguration) {
            parts.push(`Config: ${xcodeData.selectedConfiguration}`);
        }
        
        if (xcodeData.selectedDestination) {
            parts.push(`Dest: ${xcodeData.selectedDestination.name}`);
        }

        return parts.join(' | ');
    }

    /**
     * 获取Xcode项目的详细信息
     */
    getXcodeDetails(targetId: string): { configurations: string[], destinations: XcodeDestination[] } | null {
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            return null;
        }

        return {
            configurations: xcodeData.configurations,
            destinations: xcodeData.destinations
        };
    }

    /**
     * 保存用户选择到VSCode配置
     */
    async saveConfiguration(targetId: string): Promise<void> {
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            return;
        }

        try {
            if (this.context) {
                // 使用 extension context storage
                const savedConfigs = this.context.workspaceState.get<{[key: string]: any}>('bsp.xcode.targets') || {};
                
                savedConfigs[targetId] = {
                    selectedConfiguration: xcodeData.selectedConfiguration,
                    selectedDestination: xcodeData.selectedDestination,
                    lastUpdated: new Date().toISOString()
                };

                await this.context.workspaceState.update('bsp.xcode.targets', savedConfigs);
                logInfo(`Saved Xcode configuration for ${targetId} using extension context`);
            } else {
                // 回退到 workspace 配置
                const config = vscode.workspace.getConfiguration('bsp.xcode');
                const savedConfigs = config.get<{[key: string]: any}>('targets') || {};
                
                savedConfigs[targetId] = {
                    selectedConfiguration: xcodeData.selectedConfiguration,
                    selectedDestination: xcodeData.selectedDestination,
                    lastUpdated: new Date().toISOString()
                };

                await config.update('targets', savedConfigs, vscode.ConfigurationTarget.Workspace);
                logInfo(`Saved Xcode configuration for ${targetId} using workspace config`);
            }
        } catch (error) {
            logError(`Failed to save Xcode configuration for ${targetId}`, error);
        }
    }

    /**
     * 加载用户保存的配置
     */
    loadConfiguration(targetId: string): void {
        let savedConfigs: {[key: string]: any} = {};
        
        try {
            if (this.context) {
                // 尝试从 extension context storage 加载
                savedConfigs = this.context.workspaceState.get<{[key: string]: any}>('bsp.xcode.targets') || {};
            } else {
                // 回退到 workspace 配置
                const config = vscode.workspace.getConfiguration('bsp.xcode');
                savedConfigs = config.get<{[key: string]: any}>('targets') || {};
            }
        } catch (error) {
            logError(`Failed to load Xcode configuration for ${targetId}`, error);
            savedConfigs = {};
        }
        
        const savedConfig = savedConfigs[targetId];
        const xcodeData = this.xcodeData.get(targetId);
        if (xcodeData) {
            if (savedConfig) {
                xcodeData.selectedConfiguration = savedConfig.selectedConfiguration;
                xcodeData.selectedDestination = savedConfig.selectedDestination;
                logInfo(`Loaded saved Xcode configuration for ${targetId}`);
            } else {
                // 设置默认值：第一个配置和第一个目标
                xcodeData.selectedConfiguration = xcodeData.configurations[0];
                xcodeData.selectedDestination = xcodeData.destinations[0];
                logInfo(`Set default Xcode configuration for ${targetId}`);
            }
        }
    }

    /**
     * 构建Xcode项目参数
     */
    buildXcodeArguments(targetId: string, action: 'build' | 'test' | 'run' | 'archive'): string[] {
        const xcodeData = this.xcodeData.get(targetId);
        if (!xcodeData) {
            return [];
        }

        const args = [];
        
        if (xcodeData.selectedConfiguration) {
            args.push('-configuration', xcodeData.selectedConfiguration);
        }
        
        if (xcodeData.selectedDestination) {
            const dest = xcodeData.selectedDestination;
            args.push('-destination', `${dest.id}`);
        }

        // 添加action特定参数
        switch (action) {
            case 'build':
                args.push('build');
                break;
            case 'test':
                args.push('test');
                break;
            case 'run':
                args.push('run');
                break;
            case 'archive':
                args.push('archive');
                break;
        }

        return args;
    }
}