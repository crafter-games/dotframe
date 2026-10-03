# scriptc feedback from dotframe

dotframe is a TS-first game engine whose native target compiles game and engine code with scriptc 0.2.0 (static, `-O2`) and calls SDL3 and wgpu-native through FFI. This file collects what building it surfaced: performance gaps against V8, language and tooling issues, and the workarounds the engine uses today.

Machine: Apple M5 Pro, macOS 26.7. Compared with Node 24.18 (V8) and Bun 1.3.11 (JavaScriptCore). Date: 2026-10-03.

## Performance

### Summary

`bench/scriptc/patterns.ts` isolates the patterns dotframe's 2D vertex writer used. Each case touches 3 M vertices of 9 floats. Lower is better.

| Case | scriptc | Node (V8) | Bun (JSC) | scriptc / V8 |
|---|---:|---:|---:|---:|
| A. captured `let` typed array, 9 writes per closure call | 27.5 ms | 8.0 ms | 6.3 ms | 3.4× |
| B. A with a local alias taken once per call | 21.0 ms | 7.3 ms | 4.1 ms | 2.9× |
| C. inline loop, alias hoisted, no call per vertex | 10.8 ms | 5.6 ms | 3.8 ms | 1.9× |
| D. closure call reading 6 fields of a captured `let` record | 11.7 ms | 1.7 ms | 1.8 ms | 6.9× |
| E. fresh `number[]` + 24 `push` per shape | 53.7 ms | 7.7 ms | 7.3 ms | 7.0× |
| E'. reused `number[]` (`length = 0`) + 24 `push` | 20.6 ms | 12.3 ms | 4.4 ms | 1.7× |
| F. read last element of `Batch[]`, mutate one field | 60.4 ms | 2.1 ms | 3.4 ms | 28.8× |

In the engine, these patterns made the first native benchmark 14× slower than the same code in Chrome (141 ms vs 9.8 ms per frame at 50,000 sprites). Rewriting the hot paths around them brought native to 12 ms of frame building, 2.1× V8. Details: `bench/RESULTS.md`.

### F: reading and mutating an array element allocates

```ts
interface Batch { texture: number; count: number }
const batches: Batch[] = [{ texture: 1, count: 0 }];
const last = batches[batches.length - 1];
if (last.texture === 1) last.count += 6;
```

`sample` on `profile-array-record-mutation.ts`: `scr_arr_release`, `scr_arr_require_slot`, `scr_arr_retain_v`, `scr_arr_state` and `calloc` (`_malloc_zone_calloc`, `_xzm_xzone_malloc`) at the top. An element read followed by a field write on that element allocates on every iteration, and the write path goes through `scr_arr_require_slot`. The mutation does land in the array, so this looks like a copy or a temporary created and released per access rather than a semantics difference. 29× V8, the largest gap found.

### E: `push` growth reallocates often

```ts
const points: number[] = [];
for (let k = 0; k < 12; k++) points.push(k, i);
```

`sample` on `profile-array-push-growth.ts`: `xzm_realloc`, `scr_arr_push_f64`, `scr_arr_grow_dense`, `malloc_zone_size`, `realloc` and `free` dominate. 24 pushes into a fresh array spend most of their time reallocating, which suggests a small initial capacity or a growth factor close to 1. Reusing the array (`length = 0`) cuts the cost by 2.6×, which is the workaround dotframe uses for path points.

### D: each closure call pushes a dynamic `this` frame and retains the closure

```ts
let transform: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const project = (x: number, y: number): number =>
  transform.a * x + transform.c * y + transform.e + transform.b * x + transform.d * y + transform.f;
```

`sample` on `profile-closure-call.ts`: `scr_dyn_this_push_dyn`, `scr_dyn_this_pop`, `scr_closure_release` and `scr_closure_retain_v` above the function body itself. An arrow function cannot rebind `this`, so the dynamic-`this` bookkeeping looks avoidable for arrows, and a direct call to a `const` closure may not need a retain/release pair. In V8 this call is inlined. Per-call overhead is what made "one closure call per vertex" expensive in dotframe: a sprite was 6 calls.

### A and B: captured `let` bindings

The 2D layer's `vertices` buffer is a captured `let` because it is reassigned when it grows. Each access paid `scr_box_get_ref` plus a typed-array retain/release (`scr_bytes_retain_v`/`scr_bytes_release` in the engine profile). Taking a local alias once per call (B) recovers part of it; hoisting the alias out of a loop and avoiding the call (C) recovers most.

### Workarounds dotframe uses today

1. Write vertices from inline loops that take a local alias of captured bindings once, not from a helper called per vertex (`emitQuad`, the convex fan writer in `src/draw2d.ts`).
2. Pool arrays instead of creating them per shape (`startSubpath` reuses point arrays).
3. Prefer `const` bindings for buffers that rarely change; when they must grow, alias them locally in hot functions.
4. Fan-fill convex paths instead of running general ear clipping per circle (an algorithmic change, not scriptc-specific, but scriptc made the allocation-heavy version cost about 10 µs per circle).

## Language and compiler

1. **A class instance cannot be passed where an interface is expected** (SC2002, "record shapes must match exactly or width-coerce"). `run(new NativeScaler())` with `interface Scaler { scale(v: number): number }` fails. dotframe's whole backend API is plain objects of closures because of this. The diagnostic's hint ("build a literal with exactly the expected fields") is accurate but the restriction shapes the architecture of any engine with swappable backends.
2. **`number.toString(radix)`** is not available in static builds; the diagnostic suggests `--dynamic`.
3. **Increment and decrement on non-variables** (SC1090): `cells[0]++` and `counter.value++` are rejected; `x = x + 1` works.
4. **`TypedArray.prototype.fill`** has no lowering yet (SC2020); dotframe clears pixels in a loop.
5. **Elements of nested array literals are not numbers** (SC1043): `for (const rail of [[a, b], [c, d]]) for (let x = rail[0]; x < rail[1]; x++)` fails with "comparing non-number, non-string values". A flat `const values = [x1, x1 + 26]` read as `values[k]` fails the same way when `x1` comes from a function destructured out of an object (`const { X } = layer; const x1 = X(10)`); passing the values as typed parameters to a helper works.
6. **Spread of an annotated `.map()` callback parameter** (SC1090): `specs.map((spec: Spec): Out => ({ ...spec, extra: 0 }))` is rejected because the parameter is treated as possibly `undefined`. Building the object field by field in a `for...of` works.
7. **A callback with fewer parameters than an optional callback field** (SC2003, "union conversion has no unambiguous layout mapping"): with `update?: (p: P, g: G) => void`, passing `update: (p: P): void => ...` is valid TypeScript but rejected. Declaring the unused parameter (`_g: G`) compiles.
8. **Typed `.catch` parameters** (SC1090): `.catch((e: Error) => ...)` is rejected; `(e: unknown)` with `instanceof` works, as the diagnostic suggests.
9. **Library profiles cap callbacks at 32 channels** (SC4001). A native engine bridged through callbacks (library mode has no FFI) exceeds that quickly; dotframe merged related getters (`dfTouch(i, field)`, `dfMouse(field)`) to fit. Raising the cap, or allowing FFI in library builds, would remove the workaround.
10. **Library mode has no FFI and no promises** (documented). Together they mean a native app has to route every native call through profile callbacks and load synchronously; dotframe splits its API into a synchronous core plus async loaders for that reason.
11. **Promise callbacks in synchronous loops**: a game loop written as `while (poll()) frame()` never runs `.then` callbacks, so an async image load never completes. Correct per the event loop, but surprising for anyone porting a browser game, where `requestAnimationFrame` yields every frame. dotframe awaits `Promise.resolve()` once per frame. A short note in the docs for loop-style programs would help.

## FFI

1. **No string or struct returns.** dotframe returns strings by writing into a caller-provided `mutable-bytes` buffer and returning the length (`df_pref_path`). A documented pattern for "return a string" would save the next person the search.
2. **No structs by value.** Expected and documented; the engine keeps every WebGPU struct inside a C shim with scalar and byte-span parameters. It works well. Worth stating in the docs that this is the intended architecture for graphics bindings.
3. `mutable-bytes` plus format 7 `pointer` covered every case the engine needed: vertex buffers, textures, PNG and MP3 decoding, audio.

## Tooling

1. **Windows runtime pack discovery.** Cross-compiling with `SCRIPTC_TARGET=x86_64-windows-gnu` and `@scriptc/runtime-win32-x64-msvc` installed in the project still failed with `ENOENT .../node_modules/scriptc/node_modules/@scriptc/cli-darwin-arm64/dist/lib/runtime-win32-x64-msvc/package.json`. Setting `SCRIPTC_RUNTIME_PACK` to the project's pack directory fixed it. Two things were confusing: the pack is named `msvc` while the target triple says `gnu`, and the error path points inside the global CLI install, not at the project.
2. **Linking Rust static libraries on Windows** (wgpu-native) needs `unwind` in `system_libraries`; otherwise `_Unwind_*` and `_GCC_specific_handler` are undefined. A note next to the cross-compilation docs would help.
3. **`--windows-subsystem gui` executables return to the shell immediately**, so scripts and CI must wait for the process (`Start-Process -Wait` in PowerShell). Standard Windows behavior, but worth one line in the docs.
4. **Version skew with npm min-release-age**: on registries that enforce a minimum release age, the runtime pack for the installed compiler can be newer than allowed for up to two days after a release. Pinning the pack to the compiler version made this visible; nothing to fix in scriptc, but it affects anyone on such a registry.

## Reproduce

```sh
cd bench/scriptc
scriptc build patterns.ts -o patterns && ./patterns
node --experimental-strip-types patterns.ts
bun patterns.ts
# Profiles: build a profile-*.ts file, run it, then `sample <pid> 2` while it loops for 5 s.
```

### iOS library link: `scr_bytes_io.o` needs the promise runtime

With `SCRIPTC_TARGET=aarch64-apple-ios scriptc build --lib --profile`, the archive's `scr_bytes_io.o` has undefined `_scr_promise_settled_ref` and `_scr_promise_settled_void`, and library mode ships no promise runtime. The app links only after the host defines stubs for both. Library mode should either drop the async half of bytes IO or ship those two symbols.
