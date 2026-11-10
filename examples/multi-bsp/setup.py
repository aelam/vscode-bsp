#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from workspace import write_workspace


def configure_sourcekit(parser, args, directory):
    config_path = directory / ".bsp/sourcekit-bsp.json"
    if config_path.is_file() and not args.sourcekit_bsp and not args.developer_dir:
        return
    executable = args.sourcekit_bsp or shutil.which("sourcekit-bsp")
    if not executable:
        parser.error("Pass --sourcekit-bsp /path/to/sourcekit-bsp to configure the bundled Xcode project")
    executable = Path(executable).expanduser().resolve()
    if not executable.is_file() or not os.access(executable, os.X_OK):
        parser.error("--sourcekit-bsp must be an executable file")
    developer_dir = args.developer_dir or subprocess.check_output(["xcode-select", "-p"], text=True).strip()
    developer_dir = Path(developer_dir).expanduser().resolve()
    if not (developer_dir / "usr/bin/xcodebuild").is_file():
        parser.error("--developer-dir must point to Xcode's Contents/Developer directory")
    toolchain_bin = developer_dir / "Toolchains/XcodeDefault.xctoolchain/usr/bin"
    if not (toolchain_bin / "sourcekit-lsp").is_file():
        parser.error("The selected Xcode toolchain does not contain sourcekit-lsp")
    settings_path = directory / ".vscode/settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.is_file() else {}
    settings["swift.path"] = str(toolchain_bin)
    settings["swift.swiftEnvironmentVariables"] = {
        **settings.get("swift.swiftEnvironmentVariables", {}), "DEVELOPER_DIR": str(developer_dir)
    }
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({
        "name": "sourcekit-bsp",
        "version": "0.2",
        "bspVersion": "2.2.0",
        "languages": ["swift", "objective-c", "objective-cpp", "c", "cpp"],
        "argv": ["/usr/bin/env", "DEVELOPER_DIR=" + str(developer_dir), str(executable)],
        "kind": "xcode",
    }, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Set up Xcode, SwiftPM, and Kotlin BSP connections.")
    parser.add_argument("--sourcekit-bsp", type=Path, help="SourceKit BSP executable for the bundled Xcode project")
    parser.add_argument("--developer-dir", type=Path, help="Xcode Contents/Developer directory; defaults to xcode-select")
    parser.add_argument("--java-home", type=Path, help="JDK directory; defaults to JAVA_HOME or java on PATH")
    parser.add_argument("--macos-keychain", action="store_true", help="Use certificates already trusted by the macOS keychain")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    xcode = directory / "p1"
    configure_sourcekit(parser, args, xcode)
    swiftpm = directory / "p3"
    swiftpm_config = json.loads((xcode / ".bsp/sourcekit-bsp.json").read_text())
    swiftpm_config["name"] = "sourcekit-swiftpm"
    swiftpm_config["kind"] = "swiftpm"
    swiftpm_config["languages"] = ["swift"]
    (swiftpm / ".bsp").mkdir(parents=True, exist_ok=True)
    (swiftpm / ".bsp/sourcekit-bsp.json").write_text(json.dumps(swiftpm_config, indent=2) + "\n")
    (swiftpm / ".vscode").mkdir(parents=True, exist_ok=True)
    settings = xcode / ".vscode/settings.json"
    if settings.is_file():
        shutil.copyfile(settings, swiftpm / ".vscode/settings.json")
    if args.macos_keychain and sys.platform != "darwin":
        parser.error("--macos-keychain requires macOS")

    java_home = args.java_home or os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    if not java:
        parser.error("Install JDK 17 or later, or supply --java-home")
    probe = subprocess.run([java, "-XshowSettings:properties", "-version"], capture_output=True, text=True, check=True)
    match = re.search(r"^\s*java.home = (.+)$", probe.stderr, re.MULTILINE)
    if not match:
        parser.error("Could not determine the JDK directory")
    environment = os.environ.copy()
    environment["JAVA_HOME"] = match.group(1).strip()
    launch_environment = ["JAVA_HOME=" + environment["JAVA_HOME"]]
    if args.macos_keychain:
        trust_options = "-Djavax.net.ssl.trustStoreType=KeychainStore -Djavax.net.ssl.trustStore=NONE"
        environment["JAVA_TOOL_OPTIONS"] = (environment.get("JAVA_TOOL_OPTIONS", "") + " " + trust_options).strip()
        launch_environment.append("JAVA_TOOL_OPTIONS=" + environment["JAVA_TOOL_OPTIONS"])

    kotlin = directory / "p2"
    subprocess.run([str(kotlin / "mill"), "--no-server", "test"], cwd=kotlin, env=environment, check=True)
    subprocess.run([str(kotlin / "mill"), "mill.bsp.BSP/install"], cwd=kotlin, env=environment, check=True)
    generated_config = kotlin / ".bsp/mill-bsp.json"
    config = json.loads(generated_config.read_text())
    config["argv"] = ["/usr/bin/env", *launch_environment, "/bin/sh", str(kotlin / "bsp-launch.sh"), *config["argv"][1:]]
    config["version"] = config.get("millVersion", "0.12.17")
    config_path = kotlin / ".bsp/mill-bsp.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    workspace = write_workspace(directory)
    print(f"Open all configured connections in VS Code: {workspace}")


if __name__ == "__main__":
    main()
