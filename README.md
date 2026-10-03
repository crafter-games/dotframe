# dotframe

TS-first game engine. One TypeScript codebase runs on the web (WebGPU) and compiles to native macOS and Windows binaries with [scriptc](https://scriptc.dev), with no JavaScript engine in the binary.

Status: spike (S0). A TypeScript program opens an SDL3 window and draws a triangle with wgpu-native through a flat C shim.

## Layout

- `native/df_native.c`: flat C ABI over SDL3 and wgpu-native. scriptc FFI accepts scalars and byte spans only, so the shim owns every WebGPU struct.
- `examples/triangle`: the S0 program and its FFI manifests per target.
- `scripts/build-native.sh`: builds an example for `macos` or `windows`.

## Vendored dependencies (not committed)

- wgpu-native `v29.0.1.1` prebuilt (`wgpu-macos-aarch64-release`, `wgpu-windows-x86_64-gnu-release`) in `vendor/wgpu/{macos,windows}`.
- SDL3 `3.4.16` source in `vendor/SDL3-3.4.16`, built static into `vendor/build/sdl-{macos,windows}`. Windows is cross-built with zig via `vendor/toolchain/zig-windows.cmake`.

## Build

```sh
scripts/build-native.sh macos triangle
scripts/build-native.sh windows triangle   # needs zig and @scriptc/runtime-win32-x64-msvc
```
