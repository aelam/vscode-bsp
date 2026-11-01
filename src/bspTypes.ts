// BSP Protocol Types
// Based on Build Server Protocol specification

export interface BuildTargetIdentifier {
    uri: string;
}

export interface BuildTarget {
    id: BuildTargetIdentifier;
    displayName?: string;
    baseDirectory?: string;
    tags: string[];
    capabilities: BuildTargetCapabilities;
    languageIds: string[];
    dependencies: BuildTargetIdentifier[];
    dataKind?: string;
    data?: any;
}

// Generic build system data structure that can be used by any build system
export interface BuildSystemData {
    selectors: SelectorConfiguration[]; // Direct support for server data structure
    selectedValues: { [selectorKey: string]: SelectorOption }; // Store selected values by selector key
}


export interface BuildTargetCapabilities {
    canCompile: boolean;
    canTest: boolean;
    canRun: boolean;
    canDebug: boolean;
}

export interface WorkspaceBuildTargetsResult {
    targets: BuildTarget[];
}

export interface CompileParams {
    targets: BuildTargetIdentifier[];
    originId?: string;
    arguments?: string[];
}

export interface CompileResult {
    originId?: string;
    statusCode: StatusCode;
    dataKind?: string;
    data?: any;
}

export interface TestParams {
    targets: BuildTargetIdentifier[];
    originId?: string;
    arguments?: string[];
    environmentVariables?: { [key: string]: string };
    workingDirectory?: string;
}

export interface TestResult {
    originId?: string;
    statusCode: StatusCode;
    dataKind?: string;
    data?: any;
}

export interface RunParams {
    target: BuildTargetIdentifier;
    originId?: string;
    arguments?: string[];
    environmentVariables?: { [key: string]: string };
    workingDirectory?: string;
}

export interface RunResult {
    originId?: string;
    statusCode: StatusCode;
}

export interface DebugSessionParams {
    targets: BuildTargetIdentifier[];
    originId?: string;
    /// Build arguments (e.g. -configuration / -destination) — same selection
    /// used for run, so the debug build targets the chosen simulator/device.
    arguments?: string[];
    dataKind?: string;
    data?: any;
}

export interface DebugSessionAddress {
    uri: string;
}

/// lldb-dap attach/launch parameters the server hands back alongside the URI.
export interface DebugSessionData {
    request: 'attach' | 'launch';
    program?: string;
    pid?: number;
    bundleId?: string;
}

export interface DebugSessionAddressResult {
    uri: string;
    dataKind?: string;
    data?: DebugSessionData;
}

export enum StatusCode {
    Ok = 1,
    Error = 2,
    Cancelled = 3
}

export interface BuildServerCapabilities {
    compileProvider?: CompileProvider;
    testProvider?: TestProvider;
    runProvider?: RunProvider;
    debugProvider?: DebugProvider;
    inverseSourcesProvider?: boolean;
    dependencySourcesProvider?: boolean;
    dependencyModulesProvider?: boolean;
    resourcesProvider?: boolean;
    outputPathsProvider?: boolean;
    buildTargetChangedProvider?: boolean;
    jvmRunEnvironmentProvider?: boolean;
    jvmTestEnvironmentProvider?: boolean;
    canReload?: boolean;
}

export interface CompileProvider {
    languageIds: string[];
}

export interface TestProvider {
    languageIds: string[];
}

export interface RunProvider {
    languageIds: string[];
}

export interface DebugProvider {
    languageIds: string[];
}

export interface InitializeBuildParams {
    displayName: string;
    version: string;
    bspVersion: string;
    rootUri: string;
    capabilities: BuildClientCapabilities;
    data?: any;
}

export interface BuildClientCapabilities {
    languageIds: string[];
}

export interface InitializeBuildResult {
    displayName: string;
    version: string;
    bspVersion: string;
    capabilities: BuildServerCapabilities;
    data?: any;
}

export interface PublishDiagnosticsParams {
    textDocument: TextDocumentIdentifier;
    buildTarget: BuildTargetIdentifier;
    originId?: string;
    diagnostics: Diagnostic[];
    reset: boolean;
}

export interface TextDocumentIdentifier {
    uri: string;
}

export interface Diagnostic {
    range: Range;
    severity?: DiagnosticSeverity;
    code?: number | string;
    codeDescription?: CodeDescription;
    source?: string;
    message: string;
    tags?: DiagnosticTag[];
    relatedInformation?: DiagnosticRelatedInformation[];
    data?: any;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Position {
    line: number;
    character: number;
}

export enum DiagnosticSeverity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4
}

export interface CodeDescription {
    href: string;
}

export enum DiagnosticTag {
    Unnecessary = 1,
    Deprecated = 2
}

export interface DiagnosticRelatedInformation {
    location: Location;
    message: string;
}

export interface Location {
    uri: string;
    range: Range;
}

// Dynamic Selector Types
export interface SelectorOption {
    displayName: string;
    description?: string;
    arguments: string[];
    metadata?: any; // For additional data like device ID
}

export interface SelectorConfiguration {
    keyName: string;
    displayLabel: string;
    values: SelectorOption[];
}

export interface DynamicSelectorResponse {
    selectors: SelectorConfiguration[];
}
export interface TaskIdentifier { id: string; parents?: string[] }
export interface TaskStartParams {
    taskId: TaskIdentifier | string;
    originId?: string;
    eventTime?: number;
    message?: string;
}
export interface TaskProgressParams extends TaskStartParams {
    progress?: number;
    total?: number;
    unit?: string;
}
export interface TaskFinishParams extends TaskStartParams { status: StatusCode }

export interface OutputPathItem {
    uri: string;
    kind: 1 | 2;
}
export interface OutputPathsResult {
    items: { target: BuildTargetIdentifier; outputPaths: OutputPathItem[] }[];
}
