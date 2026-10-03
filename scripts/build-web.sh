#!/bin/sh
# Bundles an example for the browser. Usage: scripts/build-web.sh [example]
set -e
example=${1:-triangle}
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/build/web/$example"
mkdir -p "$out"
bun build "$root/examples/$example/main.web.ts" --outfile "$out/main.js" --target browser
cp "$root/examples/$example/index.html" "$out/"
mkdir -p "$out/assets" && cp "$root"/assets/*.glb "$root"/assets/*.png "$out/assets/"
