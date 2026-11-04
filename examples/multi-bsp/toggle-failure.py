#!/usr/bin/env python3
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description="Toggle the Kotlin sample's intentional test failure.")
parser.add_argument("state", choices=["on", "off"])
args = parser.parse_args()
marker = Path(__file__).resolve().parent / "p2/tests/resources/fail-test.txt"
if args.state == "on":
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("Intentional BSP test failure\n")
else:
    marker.unlink(missing_ok=True)
print(f"Intentional test failure: {args.state}")
