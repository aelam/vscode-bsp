#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import subprocess

from workspace import write_workspace


def main():
    parser = argparse.ArgumentParser(description="Configure the Android demo for Gradle BSP.")
    parser.add_argument("--server", type=Path, required=True, help="Path to the gradle-bsp command")
    parser.add_argument("--java-home", type=Path, help="JDK 17 or later for the server")
    parser.add_argument("--android-sdk", type=Path, help="Android SDK directory; defaults to ANDROID_HOME or the macOS SDK path")
    args = parser.parse_args()

    server = args.server.expanduser().resolve()
    if not server.is_file() or not os.access(server, os.X_OK):
        parser.error("--server must be an executable file")
    sdk = args.android_sdk or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or Path.home() / "Library/Android/sdk"
    sdk = Path(sdk).expanduser().resolve()
    if not (sdk / "platforms/android-34/android.jar").is_file():
        parser.error("--android-sdk must contain Android SDK Platform 34")
    argv = ["/usr/bin/env", "ANDROID_HOME=" + str(sdk)]
    if args.java_home:
        java_home = args.java_home.expanduser().resolve()
        if not (java_home / "bin/java").is_file():
            parser.error("--java-home must point to a JDK")
        argv.append("JAVA_HOME=" + str(java_home))
    argv.append(str(server))
    result = subprocess.run(argv + ["--version"], capture_output=True, text=True, check=True)
    version = result.stdout.strip()
    if not version:
        parser.error("The server did not report a version")

    directory = Path(__file__).resolve().parent
    (directory / "p5/local.properties").write_text("sdk.dir=" + str(sdk) + "\n")
    config = {
        "name": "gradle-build-server",
        "version": version,
        "bspVersion": "2.1.0-M4",
        "languages": ["java"],
        "argv": argv,
    }
    config_path = directory / "p5/.bsp/gradle-bsp.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    workspace = write_workspace(directory)
    print(f"Open workspace in VS Code: {workspace}")


if __name__ == "__main__":
    main()
