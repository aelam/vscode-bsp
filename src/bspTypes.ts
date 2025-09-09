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

export interface XcodeTarget {
    projectPath: string;
    schemes: XcodeScheme[];
    destinations: XcodeDestination[];
    selectedScheme?: string;
    selectedDestination?: string;
}

export interface XcodeScheme {
    name: string;
    type: 'run' | 'test' | 'archive' | 'analyze';
    buildable: boolean;
}

export interface XcodeDestination {
    id: string;
    name: string;
    platform: 'iOS' | 'macOS' | 'watchOS' | 'tvOS';
    deviceType: 'simulator' | 'device' | 'mac';
    version?: string;
    identifier?: string;
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
    dataKind?: string;
    data?: any;
}

export interface DebugSessionAddress {
    uri: string;
}

export interface DebugSessionAddressResult {
    uri: string;
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