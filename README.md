# dotframe

TS-first game engine. One TypeScript codebase runs on the web (WebGPU) and compiles to native macOS and Windows binaries with [scriptc](https://scriptc.dev), with no JavaScript engine in the binary.

Status: S2. `examples/suzanne` loads a glTF mesh, spawns three entities in a minimal ECS and renders them lit with depth and a perspective camera. The same game code renders in the browser (WebGPU) and in native macOS and Windows binaries (SDL3 + wgpu-native through a flat C shim). CI runs both binaries and captures them with [cuse](https://github.com/crafter-agents/cuse).

## Layout

- `native/df_native.c`: flat C ABI over SDL3 and wgpu-native. scriptc FFI accepts scalars and byte spans only, so the shim owns every WebGPU struct.
- `src/gpu.ts`: backend-agnostic types for game code. Backends are plain objects of functions, because scriptc compiles structural types as record copies and a class cannot stand in for an interface.
- `src/math.ts`, `src/ecs.ts`, `src/gltf.ts`, `src/render.ts`: column-major matrices, a Map-per-component ECS, a `.glb` reader (positions, normals, indices) and a lit mesh renderer.
- `src/native`: FFI declarations and the native run loop. `native/ffi.{macos,windows}.json` bind them for every example.
- `src/web`: the browser run loop over `navigator.gpu`.
- `examples/*`: `game.ts` is shared; `main.native.ts` and `main.web.ts` pick the backend.
- `assets/suzanne.glb`: Blender's Suzanne from the Khronos glTF sample assets (CC0, Norbert Nopper / UX3D), packed geometry-only.
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
