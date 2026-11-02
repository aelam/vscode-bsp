import type * as vscode from 'vscode';
import type { BspConnection } from './bspConnectionManager';
import type { BuildTarget } from './bspTypes';

export interface TestSelection { dataKind: string; data: unknown }
export interface DiscoveredTest {
    id: string;
    label: string;
    uri: vscode.Uri;
    range: vscode.Range;
    disabled: boolean;
    children: DiscoveredTest[];
    selector?: unknown;
}
export interface TestDiscovery extends vscode.Disposable {
    onDidChange: vscode.Event<void>;
    discover(targets: BuildTarget[], token: vscode.CancellationToken): Promise<Map<string, DiscoveredTest[]>>;
    selection(target: BuildTarget, tests: DiscoveredTest[]): TestSelection;
}
export type TestDiscoveryFactory = (connection: BspConnection) => TestDiscovery | undefined;
export interface TestCatalog {
    items: Map<string, vscode.TestItem>;
    selected?: vscode.TestItem[];
}
