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

`build/logMessage` appears in **Output → vscode-bsp-log**. Compiler diagnostics appear
in **Problems** and are tracked separately for each target. The server supplies the
messages; the client does not parse tool-specific build output.

Right-click a build target and choose **Reveal Build Output**, or run **BSP: Reveal
Build Output** from the Command Palette. The client requests `buildTarget/outputPaths`
and reveals the selected location in the system file manager. It does not infer
paths from the build tool. The server must advertise `outputPathsProvider`.

Run `npm run test:protocol` to check progress, cancellation, diagnostics, and output paths.

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
