#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec /bin/sh .tools/server/server/build/install/gradle-bsp-server/bin/gradle-bsp-server --stdio
