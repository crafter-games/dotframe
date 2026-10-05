#!/bin/sh
# Builds a native binary. Usage: scripts/build-native.sh <macos|windows> <example-name | path/to/main.native.ts> [out-name]
set -e
target=$1
entry=${2:-triangle}
root=$(cd "$(dirname "$0")/.." && pwd)
case $entry in
  *.ts) entry_file=$(cd "$(dirname "$entry")" && pwd)/$(basename "$entry"); name=${3:-$(basename "$(dirname "$entry_file")")} ;;
  *) entry_file="$root/examples/$entry/main.native.ts"; name=${3:-$entry} ;;
esac
mkdir -p "$root/build/$target"
case $target in
  macos)
    for unit in df_native df_audio; do
      clang -O2 -c "$root/native/$unit.c" -I"$root/vendor/SDL3-3.4.16/include" -I"$root/vendor/wgpu/macos/include" \
        -mmacosx-version-min=14.0 -o "$root/build/macos/$unit.o"
    done
    clang -O2 -fobjc-arc -c "$root/native/df_ws_apple.m" -I"$root/vendor/SDL3-3.4.16/include" -mmacosx-version-min=14.0 \
      -o "$root/build/macos/df_ws.o"
    ar rcs "$root/build/macos/libdf_native.a" "$root/build/macos/df_native.o" "$root/build/macos/df_audio.o" "$root/build/macos/df_ws.o"
    cd "$(dirname "$entry_file")" && scriptc build "$(basename "$entry_file")" --ffi "$root/native/ffi.macos.json" \
      -o "$root/build/macos/$name"
    ;;
  windows)
    for unit in df_native df_audio; do
      zig cc -target x86_64-windows-gnu -O2 -c "$root/native/$unit.c" -I"$root/vendor/SDL3-3.4.16/include" \
        -I"$root/vendor/wgpu/windows/include" -o "$root/build/windows/$unit.o"
    done
    zig cc -target x86_64-windows-gnu -O2 -c "$root/native/df_ws_win.c" -I"$root/vendor/SDL3-3.4.16/include" \
      -o "$root/build/windows/df_ws.o"
    zig ar rcs "$root/build/windows/libdf_native.a" "$root/build/windows/df_native.o" "$root/build/windows/df_audio.o" "$root/build/windows/df_ws.o"
    cd "$(dirname "$entry_file")" && SCRIPTC_RUNTIME_PACK="$root/node_modules/@scriptc/runtime-win32-x64-msvc" \
      SCRIPTC_TARGET=x86_64-windows-gnu scriptc build "$(basename "$entry_file")" --ffi "$root/native/ffi.windows.json" \
      --windows-subsystem gui -o "$root/build/windows/$name.exe"
    ;;
  *) echo "usage: $0 <macos|windows> <example | path/to/main.native.ts> [out-name]" >&2; exit 2 ;;
esac
