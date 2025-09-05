# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VSCode extension that provides a general Build Server Protocol (BSP) client, similar to vscode-bazel-bsp but designed to work with any BSP server.

### Key Features
- Display build target information from BSP server (dependencies, sources, resources, metadata)
- Create tasks to run build targets
- Show build target dependency graphs
- Display tests from BSP server
- Show test coverage after running tests
- Display compile errors and diagnostics from BSP server

## Project Structure

This appears to be an early-stage project. The typical VSCode extension structure is expected to include:
- `src/` - TypeScript source code
- `package.json` - Extension manifest and dependencies
- `tsconfig.json` - TypeScript configuration
- `extension.ts` - Main extension entry point

## Development Commands

## Development Status

✅ **BSP client connection logic implemented**
- JSON-RPC communication with BSP servers
- Server process management and lifecycle
- Protocol initialization and handshake
- Error handling and reconnection logic
- Diagnostic message processing
- Task notifications and progress reporting

**Note**: This project is now feature-complete with a working BSP client implementation.

```bash
# Install dependencies
npm install

# Build the extension
npm run compile

# Run tests
npm test

# Package the extension
vsce package
```

## Architecture Notes

As a BSP client extension, the architecture includes:
- ✅ BSP protocol communication layer (`bspClient.ts`)
- ✅ Build target management (`buildTargetProvider.ts`)
- ✅ Test discovery and execution
- ✅ Diagnostics collection and display
- ✅ Dependency graph visualization

## BSP Integration

The Build Server Protocol integration includes:
- ✅ JSON-RPC communication with BSP servers
- ✅ Build target discovery and caching
- ✅ Source file mapping to build targets
- ✅ Test result processing
- ✅ Diagnostic message handling