#!/bin/sh
# Builds an example as a native binary. Usage: scripts/build-native.sh <macos|windows> <example>
set -e
target=$1
example=${2:-triangle}
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/build/$target"
case $target in
  macos)
    clang -O2 -c "$root/native/df_native.c" -I"$root/vendor/SDL3-3.4.16/include" -I"$root/vendor/wgpu/macos/include" \
      -mmacosx-version-min=14.0 -o "$root/build/macos/df_native.o"
    ar rcs "$root/build/macos/libdf_native.a" "$root/build/macos/df_native.o"
    cd "$root/examples/$example" && scriptc build main.native.ts --ffi "$root/native/ffi.macos.json" -o "$root/build/macos/$example"
    ;;
  windows)
    zig cc -target x86_64-windows-gnu -O2 -c "$root/native/df_native.c" -I"$root/vendor/SDL3-3.4.16/include" \
      -I"$root/vendor/wgpu/windows/include" -o "$root/build/windows/df_native.o"
    zig ar rcs "$root/build/windows/libdf_native.a" "$root/build/windows/df_native.o"
    cd "$root/examples/$example" && SCRIPTC_RUNTIME_PACK="$root/node_modules/@scriptc/runtime-win32-x64-msvc" SCRIPTC_TARGET=x86_64-windows-gnu scriptc build main.native.ts --ffi "$root/native/ffi.windows.json" \
      --windows-subsystem gui -o "$root/build/windows/$example.exe"
    ;;
  *) echo "usage: $0 <macos|windows> [example]" >&2; exit 2 ;;
esac
