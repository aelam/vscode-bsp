# BSP Client Extension

A VSCode extension that provides Build Server Protocol (BSP) client functionality.

## Features

- 🎯 **Build Target Discovery**: Automatically discovers and displays build targets from BSP servers
- 🔨 **Compilation**: Compile build targets directly from the editor
- 🧪 **Testing**: Run tests with integrated result display
- 🏃 **Execution**: Run applications and scripts
- � **Debugging**: Debug build targets through BSP server integration
- �📊 **Diagnostics**: Real-time error and warning display
- 📈 **Dependency Visualization**: View build target dependencies
- 🔄 **Real-time Updates**: Live updates from BSP server notifications

## Setup

### Prerequisites

1. A BSP-compatible build tool (e.g., Bazel with bazel-bsp, sbt, Mill, etc.)
2. VSCode 1.74.0 or later

### Configuration

1. Ensure your project has a `.bsp` directory in the workspace root
2. Create a BSP connection configuration file in the `.bsp` directory

Example `.bsp/example.json`:
```json
{
  "name": "Example BSP Server",
  "version": "1.0.0",
  "bspVersion": "2.1.0",
  "languages": ["scala", "java", "kotlin"],
  "argv": ["example-bsp-server", "--port", "0"]
}
```

For Bazel projects with bazel-bsp:
```json
{
  "name": "bazel-bsp",
  "version": "3.1.0",
  "bspVersion": "2.1.0", 
  "languages": ["scala", "java", "kotlin"],
  "argv": ["bazel-bsp", "--"]
}
```

For sbt projects:
```json
{
  "name": "sbt",
  "version": "1.8.0",
  "bspVersion": "2.1.0",
  "languages": ["scala", "java"],
  "argv": ["sbt", "bspConfig"]
}
```

## Usage

### Progress and build output

BSP task notifications update the progress notification. When a server supplies both
`progress` and `total`, the client shows a percentage. Otherwise, it shows the stage
and any reported count. Cancel sends `$/cancelRequest` to the server.

`build/logMessage` appears in **Output → vscode-bsp-log**. Both Output channels use
VS Code's log styling and level filters: errors use Error, warnings and cancelled
tasks use Warning, and other output uses Info. Failed tasks use Error even when
the preceding progress messages are informational. Colors follow the active theme.

Compiler diagnostics appear in **Problems** and are tracked separately for each
target. The server supplies the messages and severity; the client does not parse
tool-specific build output. Raw process output without a level stays informational.

Right-click a build target and choose **Reveal Build Output**, or run **BSP: Reveal
Build Output** from the Command Palette. The client requests `buildTarget/outputPaths`
and reveals the selected location in the system file manager. It does not infer
paths from the build tool. The server must advertise `outputPathsProvider`.

Run `npm run test:protocol` to check progress, cancellation, diagnostics, and output paths.

### Testing panel

The native VS Code **Testing** panel lists test targets from connected BSP servers.
Use **Run Tests** to run a target, or run all targets from the panel toolbar.
The existing **BSP: Test Target** command also publishes results to this panel.
Configuration and destination selections come from the Build Targets view.
The Stop button cancels the corresponding BSP request.

With an updated sourcekit-bsp, the Swift discovery adapter finds XCTest and Swift
Testing functions before execution. Open a test file and use the play button
beside a test or suite. The same tests appear under their target in the Testing
panel. You can select cases or exclude cases from a run. Results update the
existing nodes; failures include messages and links to their source.

The adapter uses SourceKit-LSP from the server's advertised toolchain. It runs a
separate discovery session with background indexing disabled, without access to
private Swift extension APIs. It requires SourceKit-LSP test discovery version 2
and one `.bsp/*.json` configuration per workspace folder. Source edits refresh
locations automatically; the Testing panel's Refresh action retries discovery.
Selected source files are saved before execution.

Other BSP servers retain target execution and standard `test-start`,
`test-finish`, and `test-report` display. Discovery adapters supply identifiers,
locations, and selection data through `TestDiscovery`; the Testing controller does
not parse Swift or Xcode logs. Display names alone never make a case runnable.

With sourcekit-bsp, case results arrive after each target completes. Parameterized
tests run as a whole function; individual arguments and test debugging are not
supported. Output is available in Test Results and **Output → vscode-bsp-log**.
See the server's [test selection contract](https://github.com/aelam/sourcekit-bsp/blob/main/Docs/wiki/Build-Run-Test-Debug.md#test-discovery-and-selection)
for the optional metadata and payloads.

### Activation

The extension automatically activates when it detects a `.bsp` directory in your workspace.

### Build Targets View

- The "Build Targets" view appears in the Explorer panel
- Displays all discoverable build targets with their capabilities
- Shows target metadata including:
  - Dependencies
  - Supported languages
  - Available actions (compile, test, run)

### Commands

- **BSP: Refresh Build Targets** - Refresh the build targets view
- **BSP: Show Build Targets** - Focus on the build targets view
- **BSP: Compile Target** - Compile the selected build target
- **BSP: Test Target** - Run tests for the selected build target  
- **BSP: Run Target** - Execute the selected build target
- **BSP: Debug Target** - Debug the selected build target

### Context Menu Actions

Right-click on build targets in the tree view to access:
- Compile actions for compilable targets
- Test actions for test targets  
- Run actions for executable targets

### Status and Notifications

- Status bar shows BSP connection status and task progress
- Notifications display compilation, test, and execution results
- Problems panel shows diagnostics and errors from the BSP server

## Diagnostics Integration

The extension integrates with VSCode's diagnostics system:
- Compilation errors appear in the Problems panel
- Error highlights appear directly in source files
- Quick navigation to error locations

## Troubleshooting

### Connection Issues

1. **No BSP configuration found**
   - Ensure `.bsp` directory exists in workspace root
   - Verify BSP configuration file has correct format
   - Check that BSP server command is accessible

2. **BSP server fails to start**
   - Verify the `argv` command in BSP configuration is correct
   - Check if BSP server is installed and in PATH
   - Review VSCode Developer Console for detailed error messages

3. **No build targets appear**
   - Ensure BSP server supports `workspace/buildTargets` request
   - Check if project is properly configured for the build tool
   - Try refreshing build targets manually

### Performance

- Large projects may take time to load all build targets
- Use the refresh command sparingly to avoid overwhelming the BSP server
- Monitor VSCode Developer Console for performance insights

## Development

### Building from Source

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Package extension
vsce package
```

### Testing

```bash
# Run tests
npm test

# Lint code
npm run lint
```

## BSP Protocol Support

This extension implements BSP Protocol version 2.1.0 and supports:

- ✅ `build/initialize` - Server initialization
- ✅ `build/initialized` - Initialization completion
- ✅ `build/shutdown` - Graceful shutdown
- ✅ `build/exit` - Server termination
- ✅ `workspace/buildTargets` - Build target discovery
- ✅ `buildTarget/sources` - Source ownership for test discovery
- ✅ `buildTarget/compile` - Target compilation
- ✅ `buildTarget/test` - Test execution
- ✅ `buildTarget/run` - Target execution
- ✅ `debugSession/start` - Debug session initiation
- ✅ `build/publishDiagnostics` - Diagnostic notifications
- ✅ `build/taskStart` - Task start notifications
- ✅ `build/taskProgress` - Task progress notifications
- ✅ `build/taskFinish` - Task completion notifications
- ✅ `build/logMessage` - Server log messages
- ✅ `build/showMessage` - Server notifications

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This extension is released under the MIT License.
