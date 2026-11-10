#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

from workspace import write_workspace


SERVER_COMMIT = "6a424f4598b3a2032542eb5230ec05af126d45ef"
SERVER_SHA256 = "0ffdf1eb2fa8d14b89b612e68cc6912f9b80013e79531cba28c9247d886fe235"
GRADLE_VERSION = "8.13"
GRADLE_SHA256 = "20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78"


def download(url, destination, checksum, supplied=None):
    if supplied:
        shutil.copyfile(supplied, destination)
    if not destination.exists():
        subprocess.run(["curl", "--fail", "--location", "--retry", "2", url, "--output", str(destination)], check=True)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != checksum:
        raise SystemExit(f"Checksum mismatch: {destination}")


def main():
    parser = argparse.ArgumentParser(description="Build a pinned Gradle BSP server and configure the Java demo.")
    parser.add_argument("--java-home", type=Path, help="JDK 17 directory; defaults to JAVA_HOME or java on PATH")
    parser.add_argument("--macos-keychain", action="store_true", help="Use certificates already trusted by the macOS keychain")
    parser.add_argument("--gradle-user-home", type=Path, help="Override the Gradle cache directory")
    parser.add_argument("--source-archive", type=Path, help="Use a downloaded archive of the pinned server commit")
    parser.add_argument("--gradle-archive", type=Path, help="Use a downloaded Gradle 8.13 binary distribution")
    args = parser.parse_args()
    if args.macos_keychain and sys.platform != "darwin":
        parser.error("--macos-keychain requires macOS")
    java_home = args.java_home or os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    if not java:
        parser.error("Install JDK 17 or supply --java-home")
    probe = subprocess.run([java, "-XshowSettings:properties", "-version"], capture_output=True, text=True, check=True)
    home_match = re.search(r"^\s*java.home = (.+)$", probe.stderr, re.MULTILINE)
    version_match = re.search(r"^\s*java.specification.version = (.+)$", probe.stderr, re.MULTILINE)
    if not home_match or not version_match or version_match.group(1).strip() != "17":
        parser.error("This pinned demo requires JDK 17")

    directory = Path(__file__).resolve().parent
    project = directory / "p4"
    tools = project / ".tools"
    tools.mkdir(parents=True, exist_ok=True)
    server_archive = tools / "server.tar.gz"
    gradle_archive = tools / "gradle.zip"
    download(f"https://codeload.github.com/opencastsoftware/gradle-bsp/tar.gz/{SERVER_COMMIT}",
             server_archive, SERVER_SHA256, args.source_archive)
    download(f"https://downloads.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip",
             gradle_archive, GRADLE_SHA256, args.gradle_archive)
    server = tools / "server"
    if not (server / "settings.gradle.kts").is_file():
        server.mkdir(exist_ok=True)
        subprocess.run(["tar", "-xzf", str(server_archive), "-C", str(server), "--strip-components=1"], check=True)
    gradle = tools / f"gradle-{GRADLE_VERSION}/bin/gradle"
    if not gradle.is_file():
        with zipfile.ZipFile(gradle_archive) as archive:
            archive.extractall(tools)

    repository = tools / "m2"
    cache = (args.gradle_user_home or tools / "gradle-cache").expanduser().resolve()
    environment = os.environ.copy()
    environment["JAVA_HOME"] = home_match.group(1).strip()
    environment["GRADLE_USER_HOME"] = str(cache)
    java_options = environment.get("JAVA_TOOL_OPTIONS", "")
    if args.macos_keychain:
        java_options += " -Djavax.net.ssl.trustStoreType=KeychainStore -Djavax.net.ssl.trustStore=NONE"
    java_options += f' "-Dmaven.repo.local={repository}"'
    environment["JAVA_TOOL_OPTIONS"] = java_options.strip()
    init_script = tools / "build.init.gradle"
    init_script.write_text("""allprojects {
    afterEvaluate {
        def javaExtension = extensions.findByType(org.gradle.api.plugins.JavaPluginExtension)
        if (javaExtension != null) {
            javaExtension.toolchain.languageVersion = JavaLanguageVersion.of(17)
        }
    }
}
""")
    subprocess.run(["/bin/sh", str(gradle), "--no-daemon", "--no-watch-fs", "--max-workers=2",
                    "--init-script", str(init_script),
                    ":gradle-bsp-server:installDist", ":gradle-bsp-plugin:publishToMavenLocal",
                    ":gradle-bsp-model:publishToMavenLocal", "-x", "test"],
                   cwd=server, env=environment, check=True)

    wrapper = project / "gradle/wrapper"
    wrapper.mkdir(parents=True, exist_ok=True)
    (wrapper / "gradle-wrapper.properties").write_text(
        f"distributionUrl={gradle_archive.as_uri()}\ndistributionSha256Sum={GRADLE_SHA256}\n")
    build_info = server / "server/build/generated/sources/buildinfo/java/main/com/opencastsoftware/gradle/bsp/server/BuildInfo.java"
    server_version = re.search(r'public static final String version = "([^"]+)";', build_info.read_text())
    if not server_version:
        raise SystemExit("The Gradle BSP build did not report a version")
    (tools / "bsp-version").write_text(server_version.group(1) + "\n")
    subprocess.run(["/bin/sh", str(gradle), "--no-daemon", "--no-watch-fs", "--max-workers=2", "test"],
                   cwd=project, env=environment, check=True)
    config = {
        "name": "gradle-bsp", "version": server_version.group(1), "bspVersion": "2.1.1",
        "languages": ["java"],
        "argv": ["/usr/bin/env", "JAVA_HOME=" + environment["JAVA_HOME"],
                 "GRADLE_USER_HOME=" + str(cache), "JAVA_TOOL_OPTIONS=" + environment["JAVA_TOOL_OPTIONS"],
                 "/bin/sh", str(project / "bsp-launch.sh")],
    }
    (project / ".bsp").mkdir(exist_ok=True)
    (project / ".bsp/gradle-bsp.json").write_text(json.dumps(config, indent=2) + "\n")
    workspace = write_workspace(directory)
    print(f"Open workspace in VS Code: {workspace}")
    print("Gradle BSP uses the standard protocol. Android, debugging, and the context extension are not provided.")


if __name__ == "__main__":
    main()
