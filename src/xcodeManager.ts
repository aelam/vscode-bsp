import * as vscode from 'vscode';
import { BuildTarget, XcodeData, XcodeDestination } from './bspTypes';
import { logInfo, logError } from './logger';

export class XcodeManager {
    private xcodeData = new Map<string, XcodeData>();
    private _onDidChangeConfiguration = new vscode.EventEmitter<string>();
    readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;
    private context?: vscode.ExtensionContext;
    public readonly _instanceId: string;

    constructor(context?: vscode.ExtensionContext) {
        this.context = context;
        this._instanceId = `xcodeManager-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        logInfo(`🆔 XcodeManager created with instance ID: ${this._instanceId}`);
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
    extractXcodeData(target: BuildTarget): XcodeData | null {
        logInfo(`🔍 [${this._instanceId}] extractXcodeData called for target: ${target.id.uri}`);
        logInfo(`🗂️ [${this._instanceId}] Current xcodeData Map size: ${this.xcodeData.size}`);
        logInfo(`🗂️ [${this._instanceId}] Current xcodeData keys: [${Array.from(this.xcodeData.keys()).join(', ')}]`);
        
        if (!this.isXcodeTarget(target)) {
            logInfo(`❌ [${this._instanceId}] Target ${target.id.uri} is not an Xcode target`);
            return null;
        }

        try {
            let xcodeData: XcodeData;
            
            if (target.data && target.data.xcode) {
                // 使用已存在的xcode数据，但确保格式正确
                xcodeData = target.data.xcode as XcodeData;
                logInfo(`✅ [${this._instanceId}] Using existing xcode data from target.data.xcode`);
            } else {
                // 从BSP数据中提取Xcode信息
                xcodeData = {
                    configurations: target.data?.configurations || [],
                    destinations: target.data?.destinations || [],
                    selectedConfiguration: undefined,
                    selectedDestination: undefined,
                };
                logInfo(`✅ [${this._instanceId}] Extracted xcode data from BSP data: ${xcodeData.configurations.length} configs, ${xcodeData.destinations.length} destinations`);
            }

            // 更新缓存并加载用户配置（无论数据来源）
            this.xcodeData.set(target.id.uri, xcodeData);
            this.loadConfiguration(target.id.uri);
            
            logInfo(`💾 [${this._instanceId}] Stored xcode data for ${target.id.uri}. Map size now: ${this.xcodeData.size}`);
            
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
            iconPath: this.getDestinationIcon(dest),
            label: dest.name,
            description: `${dest.platform} ${dest.simulator ? '(Simulator)' : '(Device)'} ${dest.version ? '- ' + dest.version : ''}` + (dest.isAvailable === false ? ' (Unavailable)' : ''), 
            detail: dest.id,
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
        const data = this.xcodeData.get(targetId);
        logInfo(`🎯 [${this._instanceId}] getSelectedConfiguration for ${targetId}: ${data?.selectedConfiguration || 'undefined'}`);
        logInfo(`🗂️ [${this._instanceId}] Current xcodeData Map size: ${this.xcodeData.size}, keys: [${Array.from(this.xcodeData.keys()).join(', ')}]`);
        return data?.selectedConfiguration;
    }

    /**
     * 获取当前选择的destination
     */
    getSelectedDestination(targetId: string): XcodeDestination | undefined {
        const data = this.xcodeData.get(targetId);
        logInfo(`🎯 [${this._instanceId}] getSelectedDestination for ${targetId}: ${data?.selectedDestination?.id || 'undefined'}`);
        logInfo(`🗂️ [${this._instanceId}] Current xcodeData Map size: ${this.xcodeData.size}, keys: [${Array.from(this.xcodeData.keys()).join(', ')}]`);
        return data?.selectedDestination;
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
            parts.push(`Configuration: ${xcodeData.selectedConfiguration}`);
        }
        
        if (xcodeData.selectedDestination) {
            parts.push(`${xcodeData.selectedDestination.name}` + (xcodeData.selectedDestination.version ? ` (${xcodeData.selectedDestination.version})` : ''));
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

    getDestinationIcon(destination: XcodeDestination): vscode.ThemeIcon {
        if (destination.simulator) {
            return new vscode.ThemeIcon('device-mobile');
        }
        
        return new vscode.ThemeIcon('device-desktop');
    }

    // Debug method to access xcodeData Map size
    getXcodeDataSize(): number {
        return this.xcodeData.size;
    }

    // Debug method to get all target IDs in xcodeData Map
    getXcodeDataKeys(): string[] {
        return Array.from(this.xcodeData.keys());
    }

}