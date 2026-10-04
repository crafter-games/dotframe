---
name: macos
description: Build and run native macOS (and Windows) binaries of a dotframe game with scriptc. Use when compiling natively, setting up the vendored SDL3 and wgpu-native, reading a native build failure, benchmarking, or debugging the native backend.
---
# macos

```sh
dotframe vendor macos          # once per machine: wgpu-native + SDL3 into ~/.dotframe/vendor (about 1 minute)
dotframe doctor                # vendor:<target>, scriptc, zig for windows
dotframe build macos --json    # dist/macos/<name>
./dist/macos/<name>            # run from the game root: asset paths are relative to it
```

## Native targets

A target with `"native"` is built by the CLI itself:

```json
"macos": { "native": { "platform": "macos", "entry": "main.native.ts" } },
"windows": { "native": { "platform": "windows", "entry": "main.native.ts" } }
```

The CLI copies the engine (`src/`) and the game's `.ts` and `.json` files into `.dotframe/native/<target>/`, rewrites `dotframe/...` imports to relative paths, compiles the C shim against the vendored SDL3 and wgpu-native, and runs scriptc. This is why it works from `node_modules`: scriptc treats code under `node_modules` as package code for its dynamic engine and takes only relative imports in a static build, so building in place fails.

- Vendor lives in `DOTFRAME_VENDOR`, else a dotframe git checkout's `vendor/` when populated, else `~/.dotframe/vendor`. It survives reinstalling dotframe and is shared by every game.
- Output goes to the game's `dist/<target>/`, never into `node_modules`.
- On failure, `error.log` (and the message) points at `.dotframe/logs/build-<target>.log` with the full compiler output. Read it; the message only carries the tail.
- Windows cross-builds with zig (`brew install zig`), needs `dotframe vendor windows`, and needs scriptc's Windows runtime pack in the game (`bun add -d @scriptc/runtime-win32-x64-msvc`, about 63 MB, so templates leave it out).
- A target with `"steps"` instead (like Crafter Smash, which vendors dotframe as a submodule) runs its own scripts.

## Code that compiles natively

scriptc compiles a subset of TypeScript. What tripped the templates:

- No `Object.assign` on an existing object: assign fields one by one.
- Object spread needs every field to have an earlier source: `{ ...c, taken: false }` over a mapped literal fails; build the records explicitly.
- Structural types become record copies, so engine backends are plain objects of functions, not classes behind interfaces.
- Keep native-only code in `main.native.ts`; share the rest (see the templates' `src/setup.ts`).

Run `dotframe build macos` early and after each feature: one scriptc error is a quick fix, ninety are a port.

## Other notes

- Benchmarks mean nothing while other processes load the machine. Check `top` first and say what else was running.
- Hidden or occluded windows skip frames and can spin a core. Keep test windows visible.
