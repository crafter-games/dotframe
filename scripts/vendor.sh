#!/bin/sh
# Downloads wgpu-native prebuilts and builds SDL3 static for a target. Usage: scripts/vendor.sh <macos|windows>
# DOTFRAME_VENDOR picks the directory (the dotframe CLI uses ~/.dotframe/vendor); default is this checkout's vendor/.
set -e
target=$1
root=$(cd "$(dirname "$0")/.." && pwd)
wgpu_version=v29.0.1.1
sdl_version=3.4.16
vendor=${DOTFRAME_VENDOR:-$root/vendor}
toolchain="$root/vendor/toolchain"
mkdir -p "$vendor/build"

case $target in
  macos) wgpu_asset=wgpu-macos-aarch64-release ;;
  windows) wgpu_asset=wgpu-windows-x86_64-gnu-release ;;
  *) echo "usage: $0 <macos|windows>" >&2; exit 2 ;;
esac

if [ ! -f "$vendor/wgpu/$target/lib/libwgpu_native.a" ]; then
  mkdir -p "$vendor/wgpu/$target"
  curl -fsSL "https://github.com/gfx-rs/wgpu-native/releases/download/$wgpu_version/$wgpu_asset.zip" -o "$vendor/wgpu/$target.zip"
  unzip -oq "$vendor/wgpu/$target.zip" -d "$vendor/wgpu/$target"
  rm "$vendor/wgpu/$target.zip"
fi

if [ ! -d "$vendor/SDL3-$sdl_version" ]; then
  curl -fsSL "https://github.com/libsdl-org/SDL/releases/download/release-$sdl_version/SDL3-$sdl_version.tar.gz" | tar xz -C "$vendor"
fi

if [ ! -f "$vendor/build/sdl-$target/libSDL3.a" ]; then
  case $target in
    macos) extra="-DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0" ;;
    windows) extra="-DCMAKE_TOOLCHAIN_FILE=$toolchain/zig-windows.cmake" ;;
  esac
  cmake -S "$vendor/SDL3-$sdl_version" -B "$vendor/build/sdl-$target" -DCMAKE_BUILD_TYPE=Release \
    -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST_LIBRARY=OFF $extra
  cmake --build "$vendor/build/sdl-$target" -j 4
fi
