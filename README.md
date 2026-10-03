# dotframe

TS-first game engine. One TypeScript codebase runs on the web (WebGPU) and compiles to native macOS and Windows binaries with [scriptc](https://scriptc.dev), with no JavaScript engine in the binary.

Status: S1. The same `examples/triangle/game.ts` renders in the browser (WebGPU) and in native macOS and Windows binaries (SDL3 + wgpu-native through a flat C shim). CI runs both binaries and captures them with [cuse](https://github.com/crafter-agents/cuse).

## Layout

- `native/df_native.c`: flat C ABI over SDL3 and wgpu-native. scriptc FFI accepts scalars and byte spans only, so the shim owns every WebGPU struct.
- `src/gpu.ts`: backend-agnostic types for game code. Backends are plain objects of functions, because scriptc compiles structural types as record copies and a class cannot stand in for an interface.
- `src/native`: FFI declarations and the native run loop.
- `src/web`: the browser run loop over `navigator.gpu`.
- `examples/triangle`: `game.ts` is shared; `main.native.ts` and `main.web.ts` pick the backend.
- `scripts/build-native.sh`: builds an example for `macos` or `windows`.

## Vendored dependencies (not committed)

- wgpu-native `v29.0.1.1` prebuilt (`wgpu-macos-aarch64-release`, `wgpu-windows-x86_64-gnu-release`) in `vendor/wgpu/{macos,windows}`.
- SDL3 `3.4.16` source in `vendor/SDL3-3.4.16`, built static into `vendor/build/sdl-{macos,windows}`. Windows is cross-built with zig via `vendor/toolchain/zig-windows.cmake`.

## Build

```sh
scripts/build-native.sh macos triangle
scripts/build-native.sh windows triangle   # needs zig and @scriptc/runtime-win32-x64-msvc
scripts/build-web.sh triangle               # then serve build/web/triangle
```
