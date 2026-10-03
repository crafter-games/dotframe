# bench2d results

Scene per frame: N moving animated sprites (32×32 from a 16×16 sheet), N/4 filled circles (radius 6, alpha) and 20 lines of text. Each stage warms up 1 s and measures 3 s. Source: `examples/bench2d` (dotframe) and `bench/canvas2d.html` (the same scene with the browser's Canvas2D, which is how Crafter Smash renders today).

Machine: MacBook Pro, Apple M5 Pro, macOS 26.7. Browser: Chrome via agent-browser, headed, `--enable-unsafe-webgpu`. Date: 2026-10-03.

## CPU time per frame (ms)

Mean time to update, build and submit one frame. Web targets are capped at 60 FPS by `requestAnimationFrame`; native runs with `DF_VSYNC=0`.

| Sprites | Canvas2D (browser) | dotframe web (V8 + WebGPU) | dotframe native (scriptc + wgpu) |
|---:|---:|---:|---:|
| 1,000 | 0.43 | 0.88 | 5.61 (0.84 build) |
| 5,000 | 1.05 | 2.15 | 6.53 (2.01 build) |
| 10,000 | 1.67 | 2.11 | 5.59 (2.76 build) |
| 20,000 | 9.59 | 3.01 | 7.22 (4.82 build) |
| 50,000 | 32.80 | 5.81 | 14.28 (12.15 build) |

Native totals below ~6 ms are dominated by waiting on the surface to present; the build column is the engine and game work.

## Frame rate at 50,000 sprites

| Target | Frame time | FPS |
|---|---:|---:|
| Canvas2D (browser) | 36.4 ms | 27 |
| dotframe web | 16.7 ms (capped) | 60 |
| dotframe native, vsync on | 13.8 ms | 60+ (72 uncapped) |

## Native footprint

- Binary: 9.7 MB, no JavaScript engine.
- Process start to first frame with assets loaded: 202 ms.
- Peak resident memory over the full run (up to 50,000 sprites): 305 MB. The 2D vertex buffer grows to about 1.6 M vertices, held on both CPU and GPU.

## What changed native performance

The first native run took 141 ms per frame at 50,000 sprites. `sample` showed the time in the scriptc runtime (boxed captured bindings, retain/release, array growth, allocation), not in rendering. Changes, measured at 50,000:

| Change | Build time |
|---|---:|
| Starting point | ~139 ms |
| Convex fan fill for arcs, ellipses and rects instead of ear clipping | 43.6 ms |
| Local aliases for captured bindings in `vertex()`, pooled path arrays | 32.4 ms |
| `emitQuad`: transform 4 corners once for sprites, rects and glyphs | 27.8 ms |
| Inline convex fan writes | 12.2 ms |

The same changes cut dotframe web from 9.8 ms to 5.8 ms at 50,000.

## Takeaways

- dotframe web beats Canvas2D from about 20,000 sprites and holds 60 FPS at 50,000, where Canvas2D drops to 27.
- Native is about 2.3× slower than V8 at building frames. Hot loops compiled by scriptc pay for captured `let` bindings and per-access retain/release; local aliases and fewer closure calls per vertex recover most of it.
- Crafter Smash draws a few hundred to a few thousand primitives per frame, well inside the native budget.

## Reproduce

```sh
scripts/build-native.sh macos bench2d && DF_VSYNC=0 DF_ROOT=$PWD build/macos/bench2d
scripts/build-web.sh bench2d   # serve build/web, open /bench2d/ and read globalThis.benchResults
# Canvas2D: serve bench/canvas2d.html next to assets/crafter.png and tools/fonts/Bangers-Regular.ttf, read window.benchResults
```
