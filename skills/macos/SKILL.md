---
name: macos
description: Build and run native macOS (and Windows) binaries of a dotframe game with scriptc. Use when compiling natively, benchmarking, or debugging the native backend.
---
# macos

```sh
dotframe build macos --json
```

The step runs dotframe's `scripts/build-native.sh macos <entry> <name>`: it compiles the C shim (SDL3 + wgpu-native) and the game with scriptc into one binary with no JavaScript engine. Windows cross-builds with zig (`build-native.sh windows`).

- Games may need env vars at run time (Crafter Smash: `CHARS=railly,anthony SMASH_ROOT=<repo> DOTFRAME=<repo>/vendor/dotframe`).
- Benchmarks mean nothing while other processes load the machine. Check `top` first and say what else was running.
- Hidden or occluded windows skip frames and can spin a core. Keep test windows visible.
- scriptc compiles a subset of TypeScript: structural types become record copies, so engine backends are plain objects of functions, not classes behind interfaces.
