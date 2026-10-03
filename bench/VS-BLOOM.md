# dotframe vs Bloom: bench2d

Same scene on both engines: N moving animated sprites (32×32 from a 16×16 sheet), N/4 alpha circles and 20 lines of text per frame, 1 s warmup and 3 s of measurement per stage. dotframe runs `examples/bench2d`; Bloom runs `bench/bloom/main.ts`, a line-for-line port onto its raylib-style API.

Machine: MacBook Pro, Apple M5 Pro, macOS 26.7, 120 Hz display. Date: 2026-10-03. Both runs back to back.

- dotframe: main at the time of the run, scriptc 0.2.0, wgpu-native v29.
- Bloom: `Bloom-Engine/engine` main at 82fd842 (2026-07-27), compiled with Perry 0.5.1520 (`perry compile main.ts -o build/bench`), `setDirect2DMode(true)`.

## Time to build one frame (ms)

Update plus draw calls, before submit. This is the CPU work the engine and the compiled TypeScript do; it is the comparable number, since Bloom stays on the display's 120 Hz vsync even with `setTargetFPS(0)`.

| Sprites | dotframe | Bloom |
|---:|---:|---:|
| 1,000 | 0.40 | 0.35 |
| 5,000 | 1.40 | 1.16 |
| 10,000 | 2.69 | 1.89 |
| 20,000 | 5.55 | 3.78 |
| 50,000 | 13.76 | 9.66 |

## At 50,000 sprites

| | dotframe | Bloom |
|---|---:|---:|
| Frame time | 17.1 ms (58 FPS, vsync off) | 13.8 ms (73 FPS) |
| Peak resident memory | 266 MB | 194 MB |
| Binary size | 10.1 MB | 31.6 MB |
| First frame, warm | 277 to 404 ms | 280 ms |
| First frame, cold | not measured | 4,253 ms (shader compile) |

## Reading

Bloom builds the frame about 30% faster. The work splits differently: each Bloom draw call is one FFI call into a Rust batcher, so vertex generation, circle tessellation and text layout happen in Rust. dotframe does all of that in TypeScript compiled by scriptc (draw2d's Canvas2D-style path API tessellates every circle), so this benchmark mostly measures scriptc-generated code against hand-written Rust. dotframe's binary is three times smaller.

## Reproduction notes

- The `@bloomengine/engine` npm package (0.4.16, 2026-06-09) does not work with Perry 0.5.1520: the full scene fails with `TypeError: Expected number for native f64 parameter`. Each draw section alone runs; sprites and text together fail. Bloom from the repository's main branch works.
- Calling `getTime()` before `initWindow()` panics with `Engine not initialized`.
- A fresh clone needs `git submodule update --init` for JoltPhysics, or the native build fails in CMake.

## After dotframe's own fixes

Three changes on dotframe's side, guided by the profile in `bench/scriptc/FEEDBACK.md` (second round):

1. 24-byte vertices instead of 36: color packed as `unorm8x4`, which cut the vertex upload (`memmove`) by a third.
2. The batch being filled lives in plain numbers, so `useTexture` no longer reads `batches[batches.length - 1]` on every draw call (pattern I, an allocation per read in scriptc builds).
3. The packed color is memoized, since consecutive draw calls almost always share a color.

Rerun back to back on the same machine:

| 50,000 sprites | dotframe before | dotframe after | Bloom |
|---|---:|---:|---:|
| Build the frame | 13.76 ms | 10.95 ms | 9.31 ms |
| Frame time | 17.1 ms | 12.9 ms | 12.7 ms |
| Peak resident memory | 266 MB | 242 MB | 243 MB |

Frame time and memory are now level with Bloom; frame building is 18% behind, down from 42%. The remaining gap is mostly path points kept in `number[]` (`fill` and `arc`, scriptc pattern H) and the refcounting on captured typed arrays in the benchmark's own update loop (pattern G).
