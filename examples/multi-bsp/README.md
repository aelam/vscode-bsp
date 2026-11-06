# Multiple BSP servers in one workspace

This example combines Xcode, SwiftPM, Kotlin with Mill, and an optional Java
project with Gradle BSP. Xcode and Mill share one workspace folder. SwiftPM and
Gradle have separate folders in the generated VS Code workspace:

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
├── p2/                      Kotlin project (Mill BSP)
│   ├── build.mill
│   ├── mill
│   ├── bsp-launch.sh
│   ├── app/
│   └── tests/
├── p3/                      SwiftPM package (SourceKit BSP)
│   ├── Package.swift
│   ├── Sources/
│   ├── Tests/
│   └── .bsp/sourcekit-bsp.json
└── p4/                      Java project (Gradle BSP, optional)
    ├── settings.gradle
    ├── app/
    └── .bsp/gradle-bsp.json
```

For Xcode and Mill, both servers receive `multi-bsp` as the workspace root.
[sourcekit-bsp](https://github.com/aelam/sourcekit-bsp)
uses `Hello.xcworkspace` to find the project in `p1`. The
[Mill](https://github.com/com-lihaoyi/mill) launcher changes its working directory
to `p2` before starting Mill. Each server supplies its own build targets, actions, and test results.
The client uses standard BSP connection files. SwiftPM and Gradle receive their
own folder as the workspace root.

## Setup

Install Xcode 16 or later with an iOS Simulator runtime, JDK 17 or later, and
Python 3.9 or later. Build or install sourcekit-bsp, then run this from the
vscode-bsp repository:

```sh
python3 examples/multi-bsp/setup.py --sourcekit-bsp /path/to/sourcekit-bsp
```

Setup writes the Xcode and Mill connections into the root `.bsp` directory and
the SwiftPM connection into `p3/.bsp`. It downloads Mill and Kotlin dependencies
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
window and open the generated `hello-swift-kotlin.code-workspace`. The BSP view
shows **sourcekit-bsp**, **mill-bsp**, and **sourcekit-swiftpm**. Opening only the
`multi-bsp` folder loads Xcode and Mill.

### Add Gradle BSP

The optional Java sample uses the real
[opencastsoftware/gradle-bsp](https://github.com/opencastsoftware/gradle-bsp)
server. With JDK 17 installed, run:

```sh
python3 examples/multi-bsp/setup-gradle.py --java-home /path/to/jdk-17
```

This builds the server from commit `6a424f4598b3a2032542eb5230ec05af126d45ef`,
publishes its plugin to a local repository inside `p4/.tools`, and runs the Java
tests. It uses Gradle 8.13 and checks the SHA-256 hashes of both downloaded
archives. It then adds **Gradle Java** to the generated workspace. Reload that
workspace to connect **gradle-bsp**.

The sample applies the published BSP plugin to its root project so Gradle can
provide the workspace model. The upstream server applies the plugin to subprojects.

Use `--macos-keychain` if the JDK needs certificates already trusted by macOS.
For cached downloads, pass `--source-archive /path/to/server.tar.gz` and
`--gradle-archive /path/to/gradle-8.13-bin.zip`. `--gradle-user-home` sets the
Gradle cache directory.

This server supports standard BSP discovery, compile, run, and test for this
Java sample. It does not implement the build context extension, Android/AGP,
or `debugSession/start`.

## Try it

- With the context-enabled SourceKit build, open **BSP Contexts** and select the
  Xcode Scheme, Configuration, and Destination before choosing an action.
  Select `Hello` and an installed iOS simulator for the app.
- Under SwiftPM, select Debug or Release and run `ContextHello`. Its output
  includes the selected configuration. Run `GreetingKitTests` in Testing.
- Under Mill, compile or run `app`. It prints `Hello, BSP!` in `vscode-bsp-log`.
- If configured, compile or run Gradle's `project ':app'` and run `test source`.
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

For the configuration extension and all four connections, use a context-enabled
sourcekit-bsp binary during setup, then run:

```sh
node examples/multi-bsp/smoke.cjs --contexts --gradle
```

Add `--xcode-build` to build the Xcode `Hello` scheme in Release through a resolved
context. This check requires an installed Xcode simulator SDK.

This starts both real servers through the extension's connection manager. It
checks their shared root, targets under `p1` and `p2`, Swift test locations, Kotlin
compile/run/test responses, and test result mapping with a small VS Code API
substitute. It also checks that Mill remains connected after SourceKit closes.
Use `--expect-failure` with the failure marker turned on. Protocol events are
saved under `.bsp-smoke/`.

`--contexts` checks Xcode's Scheme-first options, SwiftPM Debug and Release runs,
selection isolation, rejected invalid contexts, and SwiftPM tests. `--gradle`
checks discovery, compile, run, test, and connection isolation with Gradle BSP.
These checks use a VS Code API substitute; they do not verify the rendered GUI.

## Scope and build-tool constraints

The Kotlin sample verifies JVM targets and target-level test execution. Android,
Kotlin editor features, test gutter discovery, individual test selection, and
JVM debugging need separate integrations.

The pinned Gradle server advertises Run on `main source`, but only maps a run
task to `project ':app'`. Use the project target for Run. The client reports
server failures without adding Gradle-specific target rules.

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
For this reason, the SwiftPM connection has its own workspace folder.

Only the context-enabled SourceKit server supplies Scheme, Configuration, and
Destination choices through `workspace/contextOptions`. Mill and Gradle keep
their standard target actions. The client does not invent context options for
servers that do not advertise the extension.

The `mill` bootstrap script comes from
[Mill 1.3.1](https://github.com/com-lihaoyi/mill/blob/1.3.1/mill), with its MIT
license in `MILL-LICENSE`. `.mill-version` selects the build-tool version
independently of the bootstrap script.
