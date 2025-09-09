import * as vscode from 'vscode';
import { BuildTarget, XcodeTarget, XcodeScheme, XcodeDestination } from './bspTypes';
import { logInfo, logError } from './logger';

export class XcodeManager {
    private xcodeTargets = new Map<string, XcodeTarget>();
    private _onDidChangeConfiguration = new vscode.EventEmitter<string>();
    readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

    constructor() {}

    /**
     * 检查构建目标是否是Xcode项目
     */
    isXcodeTarget(target: BuildTarget): boolean {
        return target.dataKind === 'xcode' || 
               target.languageIds.includes('swift') || 
               target.languageIds.includes('objective-c') ||
               (target.data && target.data.projectPath && target.data.projectPath.endsWith('.xcodeproj'));
    }

    /**
     * 提取Xcode项目数据
     */
    extractXcodeData(target: BuildTarget): XcodeTarget | null {
        if (!this.isXcodeTarget(target)) {
            return null;
        }

        try {
            if (target.data && target.data.xcode) {
                return target.data.xcode as XcodeTarget;
            }
            
            // 从BSP数据中提取Xcode信息
            const xcodeData: XcodeTarget = {
                projectPath: target.data?.projectPath || target.baseDirectory || '',
                schemes: target.data?.schemes || this.getDefaultSchemes(),
                destinations: target.data?.destinations || this.getDefaultDestinations(),
                selectedScheme: target.data?.selectedScheme,
                selectedDestination: target.data?.selectedDestination
            };

            this.xcodeTargets.set(target.id.uri, xcodeData);
            
            // 加载保存的用户配置
            this.loadConfiguration(target.id.uri);
            
            return xcodeData;
        } catch (error) {
            logError(`Failed to extract Xcode data for ${target.displayName}`, error);
            return null;
        }
    }

    /**
     * 显示scheme选择器
     */
    async selectScheme(targetId: string): Promise<string | undefined> {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            vscode.window.showErrorMessage('No Xcode data found for this target');
            return;
        }

        const items = xcodeData.schemes.map(scheme => ({
            label: scheme.name,
            description: scheme.type,
            detail: scheme.buildable ? 'Buildable' : 'Not buildable',
            scheme: scheme
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Xcode Scheme',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            xcodeData.selectedScheme = selected.scheme.name;
            await this.saveConfiguration(targetId);
            this._onDidChangeConfiguration.fire(targetId);
            logInfo(`Selected scheme: ${selected.scheme.name} for target ${targetId}`);
            return selected.scheme.name;
        }

        return undefined;
    }

    /**
     * 显示destination选择器
     */
    async selectDestination(targetId: string): Promise<string | undefined> {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            vscode.window.showErrorMessage('No Xcode data found for this target');
            return;
        }

        const items = xcodeData.destinations.map(dest => ({
            label: dest.name,
            description: `${dest.platform} ${dest.deviceType}`,
            detail: dest.version ? `Version ${dest.version}` : undefined,
            destination: dest
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Xcode Destination',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            xcodeData.selectedDestination = selected.destination.id;
            await this.saveConfiguration(targetId);
            this._onDidChangeConfiguration.fire(targetId);
            logInfo(`Selected destination: ${selected.destination.name} for target ${targetId}`);
            return selected.destination.id;
        }

        return undefined;
    }

    /**
     * 获取当前选择的scheme
     */
    getSelectedScheme(targetId: string): string | undefined {
        return this.xcodeTargets.get(targetId)?.selectedScheme;
    }

    /**
     * 获取当前选择的destination
     */
    getSelectedDestination(targetId: string): string | undefined {
        return this.xcodeTargets.get(targetId)?.selectedDestination;
    }

    /**
     * 获取Xcode配置描述
     */
    getConfigurationDescription(targetId: string): string {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            return '';
        }

        const parts = [];
        
        if (xcodeData.selectedScheme) {
            parts.push(`Scheme: ${xcodeData.selectedScheme}`);
        }
        
        if (xcodeData.selectedDestination) {
            const dest = xcodeData.destinations.find(d => d.id === xcodeData.selectedDestination);
            if (dest) {
                parts.push(`Dest: ${dest.name}`);
            }
        }

        return parts.join(' | ');
    }

    /**
     * 获取Xcode项目的详细信息
     */
    getXcodeDetails(targetId: string): { schemes: XcodeScheme[], destinations: XcodeDestination[] } | null {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            return null;
        }

        return {
            schemes: xcodeData.schemes,
            destinations: xcodeData.destinations
        };
    }

    /**
     * 保存用户选择到VSCode配置
     */
    async saveConfiguration(targetId: string): Promise<void> {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            return;
        }

        const config = vscode.workspace.getConfiguration('bsp.xcode');
        const savedConfigs = config.get<{[key: string]: any}>('targets') || {};
        
        savedConfigs[targetId] = {
            selectedScheme: xcodeData.selectedScheme,
            selectedDestination: xcodeData.selectedDestination,
            lastUpdated: new Date().toISOString()
        };

        await config.update('targets', savedConfigs, vscode.ConfigurationTarget.Workspace);
        logInfo(`Saved Xcode configuration for ${targetId}`);
    }

    /**
     * 加载用户保存的配置
     */
    loadConfiguration(targetId: string): void {
        const config = vscode.workspace.getConfiguration('bsp.xcode');
        const savedConfigs = config.get<{[key: string]: any}>('targets') || {};
        
        const savedConfig = savedConfigs[targetId];
        if (savedConfig) {
            const xcodeData = this.xcodeTargets.get(targetId);
            if (xcodeData) {
                xcodeData.selectedScheme = savedConfig.selectedScheme || xcodeData.selectedScheme;
                xcodeData.selectedDestination = savedConfig.selectedDestination || xcodeData.selectedDestination;
                logInfo(`Loaded saved Xcode configuration for ${targetId}`);
            }
        }
    }

    /**
     * 构建Xcode项目参数
     */
    buildXcodeArguments(targetId: string, action: 'build' | 'test' | 'run' | 'archive'): string[] {
        const xcodeData = this.xcodeTargets.get(targetId);
        if (!xcodeData) {
            return [];
        }

        const args = [];
        
        if (xcodeData.selectedScheme) {
            args.push('-scheme', xcodeData.selectedScheme);
        }
        
        if (xcodeData.selectedDestination) {
            const dest = xcodeData.destinations.find(d => d.id === xcodeData.selectedDestination);
            if (dest) {
                if (dest.deviceType === 'simulator') {
                    args.push('-destination', `platform=${dest.platform} Simulator,name=${dest.name}`);
                } else if (dest.deviceType === 'device' && dest.identifier) {
                    args.push('-destination', `platform=${dest.platform},id=${dest.identifier}`);
                } else {
                    args.push('-destination', `platform=${dest.platform}`);
                }
            }
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

    private getDefaultSchemes(): XcodeScheme[] {
        return [
            { name: 'Debug', type: 'run', buildable: true },
            { name: 'Release', type: 'run', buildable: true },
            { name: 'Test', type: 'test', buildable: true }
        ];
    }

    private getDefaultDestinations(): XcodeDestination[] {
        return [
            { id: 'ios-sim', name: 'iPhone 15', platform: 'iOS', deviceType: 'simulator', version: '17.0' },
            { id: 'ios-sim-pro', name: 'iPhone 15 Pro', platform: 'iOS', deviceType: 'simulator', version: '17.0' },
            { id: 'ios-sim-ipad', name: 'iPad Pro', platform: 'iOS', deviceType: 'simulator', version: '17.0' },
            { id: 'macos', name: 'My Mac', platform: 'macOS', deviceType: 'mac' }
        ];
    }
}