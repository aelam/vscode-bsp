import json
from pathlib import Path


def write_workspace(directory: Path) -> Path:
    folders = [
        {"name": "Xcode", "path": "p1"},
        {"name": "Mill Kotlin", "path": "p2"},
        {"name": "SwiftPM", "path": "p3"},
    ]
    if (directory / "p4/.bsp/gradle-bsp.json").is_file():
        folders.append({"name": "Gradle Java", "path": "p4"})
    if (directory / "p5/.bsp/gradle-bsp.json").is_file():
        folders.append({"name": "Gradle Android", "path": "p5"})
    workspace = directory / "hello-swift-kotlin.code-workspace"
    workspace.write_text(json.dumps({"folders": folders}, indent=2) + "\n")
    return workspace
