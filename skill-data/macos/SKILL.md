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

The CLI copies the engine (`src/`) and every file the entry reaches into `.dotframe/native/<target>/`: relative imports (including ones that leave the game folder, as in a monorepo port importing `../../packages/shared/src`) and workspace packages that resolve to source (`@my/shared` linked by bun or npm workspaces). It keeps their relative layout, rewrites `dotframe/...` and workspace imports to relative paths, compiles the C shim against the vendored SDL3 and wgpu-native, and runs scriptc. This is why it works from `node_modules`: scriptc treats code under `node_modules` as package code for its dynamic engine and takes only relative imports in a static build, so building in place fails.

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

## Porting existing TypeScript

What a real port (Craft Ones, 66 errors) hit, and the fix for each:

| scriptc rejects | Do instead |
|---|---|
| `Object.assign(target, ...)` | Assign fields one by one |
| `ArrayLike<T>` / `Iterable<T>` parameters | Take `T[]` |
| `readonly T[]`, `.find`/`.filter` on readonly tuples, `for...of` over tuples | Plain arrays (`T[]`), indexed loops |
| Destructuring an `unknown` network payload | Narrow field by field with `typeof` checks |
| Non-literal index into a tuple | Make it an array |
| Dynamic keyed reads on a record whose entries have different shapes | Give every entry the same shape (optional fields), or a `switch` |
| `string[i]` | `s.charAt(i)` or `s.charCodeAt(i)` |
| `Number.parseInt` in a static build | `parseInt` or `Math.trunc(Number(s))` |
| `++`/`--` inside an expression | Its own statement |
| `satisfies Record<K, Record<string, T>>` | A plain type annotation |

Runtime traps (compile clean, fail when run):

- **Structural coercion copies.** Passing a class instance, or a wider record, to a parameter typed as a narrower structural type passes a copy: the callee's writes to scalar fields are lost (arrays inside still alias). In Craft Ones every projectile froze mid-flight. Pass the exact type, or return the updated record and copy it back. Reported to scriptc.
- **Out-of-range reads.** `rows[y - 1]?.[x]` typed as `string` but `undefined` at runtime crashes with "undefined is not representable in the target union". Bounds-check before reading.
- **`JSON.stringify` key order** differed from JavaScript in Craft Ones (not reproduced in a minimal case). Never build checksums or netplay comparisons from it.

## Debugging a native crash

`--optimization dev` builds failed to link in Craft Ones (undefined `_main`; a template game links fine). When that happens, debug the release binary with lldb: `lldb ./dist/macos/<name>`, `breakpoint set -n scr_error_new`, `run`, then `bt` shows the TypeScript call site of a runtime error.

## Other notes

- Benchmarks mean nothing while other processes load the machine. Check `top` first and say what else was running.
- Hidden or occluded windows skip frames and can spin a core. Keep test windows visible.
