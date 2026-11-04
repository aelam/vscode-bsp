# Two BSP servers in one folder

Open `examples/multi-bsp` with VS Code's **File: Open Folder**. The extension loads
two configurations from the same `.bsp` directory:

```text
multi-bsp/
├── .bsp/
│   ├── sourcekit-bsp.json
│   └── mill-bsp.json
├── Hello.xcworkspace         References p1/Hello.xcodeproj
├── p1/                      Swift project
│   ├── Hello.xcodeproj
│   ├── Hello/
│   ├── HelloTests/
│   └── HelloUITests/
└── p2/                      Kotlin project
    ├── build.mill
    ├── mill
    ├── bsp-launch.sh
    ├── app/
    └── tests/
```

Open `multi-bsp`, which contains both projects. Both servers receive this folder
as the workspace root. SourceKit BSP uses `Hello.xcworkspace` to find the project
in `p1`. The Mill launcher changes its working directory to `p2` before starting
Mill. Each server supplies its own build targets, actions, and test results.
The client uses the standard BSP connection files without folder-routing rules.

## Setup

Install Xcode 16 or later with an iOS Simulator runtime, JDK 17 or later, and
Python 3.9 or later. Build or install sourcekit-bsp, then run this from the
vscode-bsp repository:

```sh
python3 examples/multi-bsp/setup.py --sourcekit-bsp /path/to/sourcekit-bsp
```

Setup writes both BSP connection files into the root `.bsp` directory, downloads Mill and Kotlin dependencies,
and runs the Kotlin tests. Mill includes its BSP server; no separate Kotlin BSP
installation is needed. Setup also writes `.vscode/settings.json` so the Swift
extension uses the selected Xcode toolchain instead of a tool-manager shim.
Generated machine paths and build products are ignored by Git. Mill keeps its
runtime metadata in `p2/.bsp` and build products in `p2/out`. The Xcode project
has no external package dependencies or saved signing team.

Use `--developer-dir /path/to/Xcode.app/Contents/Developer` to select Xcode and
`--java-home /path/to/jdk` to select Java. If Java reports a certificate error on
macOS and the certificate is already trusted by the keychain, add
`--macos-keychain`. Setup records these choices in the local BSP commands.

Build the updated extension with `npm run compile`, then reload its development
window and open this folder. The BSP view should show both **sourcekit-bsp** and
**mill-bsp**. The generated `hello-swift-kotlin.code-workspace` also works; it
contains this single folder.

## Try it

- Under SourceKit, select an iOS simulator, compile `Hello`, then run or debug it.
- Under Mill, compile or run `app`. It prints `Hello, BSP!` in `vscode-bsp-log`.
- Open the Testing view. **BSP Tests** groups `HelloTests` and `HelloUITests` under
  SourceKit, and `hello-tests` under Mill.
- Run a target from each group. Kotlin case results appear after its first run.
  Swift discovery provides test locations even with both BSP configurations.
- Disconnect one server and check that the other remains available.

To inspect a failed Kotlin assertion, run this from the vscode-bsp repository,
then rerun `hello-tests`:

```sh
python3 examples/multi-bsp/toggle-failure.py on
```

Restore passing tests with `python3 examples/multi-bsp/toggle-failure.py off`.
The failure marker is ignored by Git.

You can also open `Hello.xcworkspace` or `p1/Hello.xcodeproj` in Xcode. For Kotlin
command-line builds, enter `p2` and run `./mill app.compile`, `./mill app.run`, or
`./mill test`.
If your Java installation needs the macOS keychain, export
`JAVA_TOOL_OPTIONS='-Djavax.net.ssl.trustStoreType=KeychainStore -Djavax.net.ssl.trustStore=NONE'`
in that terminal first.

## Automated check

After setup and `npm run compile`, run this from the vscode-bsp repository:

```sh
node examples/multi-bsp/smoke.cjs
```

This starts both real servers through the extension's connection manager. It
checks their shared root, targets under `p1` and `p2`, Swift test locations, Kotlin
compile/run/test responses, and test result mapping with a small VS Code API
substitute. It also checks that Mill remains connected after SourceKit closes.
Use `--expect-failure` with the failure marker turned on. Protocol events are
saved under `.bsp-smoke/`.

## Scope and build-tool constraints

The Kotlin sample verifies JVM targets and target-level test execution. Android,
Kotlin editor features, test gutter discovery, individual test selection, and
JVM debugging need separate integrations.

Mill is pinned to 0.12.17. Tests form the root module and depend on the application
module because Mill's BSP test handler selects root modules; nested test modules
can fail or return without executing tests. See
[Mill issue 3569](https://github.com/com-lihaoyi/mill/issues/3569). Upgrade Mill
only after the BSP checks pass, including the expected failure.

Mill can write ordinary output between BSP frames. The client forwards this
unframed text to build output and passes framed payloads unchanged to its
JSON-RPC reader. Malformed or incomplete frames still fail the connection.

SourceKit-LSP filters BSP configurations by supported languages. Swift test
discovery permits the Java/Scala/Kotlin Mill configuration, but requires a single
Swift/C-family configuration to avoid choosing the wrong server.

The `mill` bootstrap script comes from
[Mill 1.3.1](https://github.com/com-lihaoyi/mill/blob/1.3.1/mill), with its MIT
license in `MILL-LICENSE`. `.mill-version` selects the build-tool version
independently of the bootstrap script.
