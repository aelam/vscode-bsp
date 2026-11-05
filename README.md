# BSP Client Extension

A general Build Server Protocol (BSP) client for VS Code. It works with BSP servers
for different languages and build tools, including sourcekit-bsp for Xcode projects.

## Features

- 🎯 **Build Target Discovery**: Automatically discovers and displays build targets from BSP servers
- 🔨 **Compilation**: Compile build targets directly from the editor
- 🧪 **Testing**: Run tests with integrated result display
- 🏃 **Execution**: Run applications and scripts
- � **Debugging**: Debug build targets through BSP server integration
- �📊 **Diagnostics**: Real-time error and warning display
- 📈 **Dependency Visualization**: View build target dependencies
- 🔄 **Real-time Updates**: Live updates from BSP server notifications

### Debugging with F5

Choose **BSP Debug** in Run and Debug, then press F5. The client selects a build
target and requests a new debug session using the selected build settings. The
server supplies the DAP address and attach or launch parameters. No fixed port
is needed in `launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    { "name": "BSP Debug", "type": "bsp-debug", "request": "launch", "stopOnEntry": true }
  ]
}
```

The target's **Debug** action uses the same server request. A manual **Attach**
configuration is only for a live DAP endpoint whose address you already know.

For an LLDB adapter, `bsp.debug.lldbInitCommands` in workspace settings applies
to F5 and the target's Debug actions. An explicit `initCommands` array in
`launch.json` overrides the workspace array. Other adapters do not receive these
workspace commands.

If LLDB crashes in `Symbol::ResolveReExportedSymbol` with its index cache enabled,
test this workspace setting:

```json
{
  "bsp.debug.lldbInitCommands": [
    "settings set symbols.enable-lldb-index-cache false"
  ]
}
```

This disables LLDB's symbol index cache for the session. It does not delete
the cache or change SourceKit's background index. Symbol loading can take longer.

## Setup

### Prerequisites

1. A BSP-compatible server or build tool, such as bazel-bsp, sbt, Mill, or [sourcekit-bsp](https://github.com/aelam/sourcekit-bsp) for Xcode
2. VSCode 1.74.0 or later

### Installation

Install an existing local VSIX with **Extensions: Install from VSIX...**.
To run the extension from source, follow [Building from Source](#building-from-source).
The development window loads the extension for your application project.

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

For Bazel projects with [bazel-bsp](https://github.com/JetBrains/bazel-bsp):
```json
{
  "name": "bazel-bsp",
  "version": "3.1.0",
  "bspVersion": "2.1.0", 
  "languages": ["scala", "java", "kotlin"],
  "argv": ["bazel-bsp", "--"]
}
```

For [sbt](https://github.com/sbt/sbt) projects:
```json
{
  "name": "sbt",
  "version": "1.8.0",
  "bspVersion": "2.1.0",
  "languages": ["scala", "java"],
  "argv": ["sbt", "bspConfig"]
}
```

For Xcode projects on macOS, install
[sourcekit-bsp](https://github.com/aelam/sourcekit-bsp#install) and create
`.bsp/sourcekit-bsp.json` in the application folder containing the
`.xcodeproj` or `.xcworkspace`:

```json
{
  "name": "sourcekit-bsp",
  "version": "1.0",
  "bspVersion": "2.2.0",
  "languages": ["swift", "c", "cpp", "objective-c", "objective-cpp"],
  "argv": ["/absolute/path/to/sourcekit-bsp"]
}
```

Replace the `argv` path with the absolute path to your installed or built server.
For completion and code navigation, install the
[Swift extension](https://github.com/swiftlang/vscode-swift), which runs SourceKit-LSP.
Use the same Xcode toolchain for both; SourceKit-LSP and vscode-bsp use separate BSP connections.
See the server's [editor setup](https://github.com/aelam/sourcekit-bsp#connect-an-editor)
for project selection and connection details.

## Usage

1. Open the application folder containing `.bsp` in VS Code, or add it as a folder in a workspace.
   Discovery reads `.bsp/*.json` at each workspace folder's root.
2. The extension discovers and connects to servers on activation.
   If needed, run **BSP: Connect BSP Servers** from the Command Palette.
3. Run **BSP: Show Build Targets** to open **BSP Targets** in Explorer.
   Expand a target and select its build settings, such as sourcekit-bsp's **Configuration** and **Destination**.
   Use the target's compile, test, run, or debug action, as supported.
   See [Commands](#commands) for the Command Palette entries.

For one folder with both [sourcekit-bsp](https://github.com/aelam/sourcekit-bsp)
and [Mill BSP](https://github.com/com-lihaoyi/mill), see the
[multi-BSP example](examples/multi-bsp/README.md). It includes an Xcode application,
a Kotlin application, and tests for both.

### Clean build cache

Right-click a target and choose **Clean Build Cache…**, or run
**BSP: Clean Build Cache…** from the Command Palette and select a target.
Confirm the warning about shared caches before the request starts. The server
decides what to remove; this may affect other targets in the project.

Clean is unavailable while this connection has a pending operation or background
task. While cleaning, all targets on this connection stay busy until the server
responds. Clean has no cancel action because removing caches cannot be undone.
The notification shows that cleaning is in progress, and the build output records
the result. A failed or unsupported request reports an error.

Tasks in other editors, tools, or BSP connections are not visible to this guard.
Wait for those builds, tests, and indexing tasks to finish before cleaning.

### Progress and build output

Background BSP tasks, including index preparation, appear in the status bar.
The item shows the server's task name and current phase. It shows a percentage
only when the server reports a valid total. Click it to open BSP build output.
Successful and cancelled tasks remain visible for five seconds; failures remain
visible until another background task starts or the connection closes.
This reports BSP index preparation, not SourceKit-LSP's code indexing. Tasks on
SourceKit-LSP's separate BSP connection are not visible to this client.

While a target operation is pending, its buttons show a spinner, the current
phase, and a cancel action. Build, test, run, and debug share one operation lock
per target and connection. Cancellation keeps the lock until the request ends.
Different targets and servers can still run operations at the same time, except
while Clean holds all targets on its connection.

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
The **BSP: Build and Test Target** command also publishes results to this panel.
Configuration and destination selections come from the BSP Targets view.
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
tests run as a whole function; individual arguments are not supported.
Output is available in Test Results and **Output → vscode-bsp-log**.
See the server's [test selection contract](https://github.com/aelam/sourcekit-bsp/blob/main/Docs/wiki/Build-Run-Test-Debug.md#test-discovery-and-selection)
for the optional metadata and payloads.

### Debug a test target

In **BSP Targets**, click the **Build and Debug Target** icon beside a test target.
The command is also available as **BSP: Debug Tests** in the Command Palette.
It uses the target's selected test configuration and destination. The server must
advertise both `canTest` and `canDebug`. The client requests `debugSession/start`
and connects to the returned DAP endpoint.

The target action builds first. The context menu also includes
**Debug Without Building**, which sends the standard `debugSession/start` request
directly. BSP treats that request as a debug launch without an implicit compile
step.

With sourcekit-bsp, this runs the whole app-hosted unit test target on an iOS
simulator. Set breakpoints on executable lines in the test source before starting.
UI tests, physical-device test debugging, and individual test selection are not
supported yet. This entry is in BSP Targets; the Testing panel's Run Tests
profile keeps its existing behavior and result reports.

### Activation

The extension automatically activates when a workspace root contains a `.bsp`
directory, even if Git or search settings exclude it. Project sources can live in
subfolders. Activation does not depend on a language extension.

### BSP Targets View

- The "BSP Targets" view appears in the Explorer panel
- Displays all discoverable build targets with their capabilities
- Shows target metadata including:
  - Dependencies
  - Supported languages
  - Available actions (compile, test, run)

### Commands

- **BSP: Connect BSP Servers** - Connect to servers; discover configurations first if none are known
- **BSP: Discover BSP Connections** - Discover configurations added after activation
- **BSP: Refresh Build Targets** - Refresh the build targets view
- **BSP: Show Build Targets** - Focus on the BSP Targets view
- **BSP: Compile Target with the Selected Build Settings** - Compile the selected build target
- **BSP: Build and Test Target** - Build and run tests for the selected target
- **BSP: Build and Run Target** - Build and run the selected target
- **BSP: Build and Debug Target (Build First)** - Build the selected target and start debugging
- **BSP: Run Without Building** - Run the selected target without a compile step
- **BSP: Test Without Building** - Test the selected target without a compile step
- **BSP: Debug Without Building** - Debug the selected target without a compile step

Hover over a target action to see its description. The Test button appears only
for targets that advertise `canTest`.

### Context Menu Actions

Right-click on build targets in the tree view to access:
- Compile actions for compilable targets
- Test actions for test targets  
- Run actions for executable targets
- Debug actions for debuggable targets

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

Clone this repository, then run these commands from its root with Node.js, npm,
and VS Code's `code` command available:

```sh
npm ci
npm run compile
code --new-window --extensionDevelopmentPath="$PWD" /absolute/path/to/application-project
```

Replace the application path with the folder that contains your `.bsp` directory.
This opens a separate VS Code window with the development extension loaded.

Use `npm run watch` to rebuild during development.
With `vsce` installed, use `vsce package` to package the extension.

### Testing

```bash
npm ci
npm run test:protocol
```

The CI workflow compiles TypeScript and runs the protocol tests on Linux and
macOS with Node.js 24 for pull requests and pushes to `master`. These tests use
VS Code API substitutes and do not require a running editor or build server.
For checks with SourceKit BSP and Mill, see the
[multi-BSP example](examples/multi-bsp/README.md#automated-check).

## BSP Protocol Support

This extension implements BSP Protocol version 2.1.0 and supports:

- ✅ `build/initialize` - Server initialization
- ✅ `build/initialized` - Initialization completion
- ✅ `build/shutdown` - Graceful shutdown
- ✅ `build/exit` - Server termination
- ✅ `workspace/buildTargets` - Build target discovery
- ✅ `buildTarget/sources` - Source ownership for test discovery
- ✅ `buildTarget/compile` - Target compilation
- ✅ `buildTarget/cleanCache` - Build cache cleanup
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
