---
name: core
description: Core dotframe usage. Read before running any dotframe command. Covers the edit, sim, snap, replay loop, the Sim contract, the trust ladder, and how to read errors.
---
# dotframe core

dotframe is a TypeScript game engine. One codebase runs on the web (WebGPU), in Discord Activities, and as native macOS, Windows and iOS builds. The CLI lets an agent play the game without a screen: the simulation is deterministic, so the same seed and inputs always produce the same state.

## The loop

1. Edit game code.
2. `dotframe sim --mash 7 --frames 600 --json`: run it headless and read `state` and `checksum`.
3. `dotframe snap --frame 300 --mash 7 --out f300.png`: render one frame with the real WebGPU renderer, then open the PNG and look at it. The JSON state tells you what the simulation did; only the image tells you what a player sees.
4. `dotframe replay verify replays/*.json`: golden replays must still pass. If a change is meant to alter gameplay, re-record them on purpose and say so.
5. For online games, `dotframe desync` (see `dotframe skills get netplay`).
6. Only then `dotframe build <target>`.

Never claim a visual change works from the JSON alone. Snap it and look.

`sim` and `replay` stop when `over()` turns true. Pass `--through-over` to keep stepping into results and rematch flows.

## agent-browser

`snap` drives agent-browser in its own session (`dotframe-snap`), writes to an absolute path, and checks the PNG size. When you drive agent-browser yourself, always pass `--session <name>` and absolute output paths: one daemon serves the whole machine, so a relative `screenshot out.png` lands in whatever directory the daemon started in (often another repo), and viewports can leak between sessions.

## Inputs

- `--mash <seed>`: random mashing players, new input every 6 frames. Good default for smoke tests.
- `--inputs file.jsonl`: one line per frame, `[p0, p1]`, or sparse `{"frame": 120, "inputs": [p0, p1]}` held until the next line. Each input is the game's JSON shape (for example `{"right": true, "attack": true}`) or an already-encoded number.
- `--seed <n>` seeds the simulation; `--options '<json>'` overrides match options (stage, characters, stocks).
- `--every <n>` on `sim` adds a checksum trace.

## The Sim contract

`dotframe.json` names a module (`"sim": "sim.ts"`) whose default export is `defineSim({...})` from `dotframe/src/sim`: `players`, `window`, `options`, `neutral`, `encode`, `random`, and `create(platform)` returning `start`, `step`, `checksum`, `state`, `over`, `save`, `restore`, and optionally `inspect` and `render`. Rules that keep it honest:

- All simulation state changes only inside `step`. `render` reads, never writes (no spawning particles or texts from draw code).
- Randomness comes from a seeded generator that `save`/`restore` capture.
- `inspect` returns the whole state graph so `desync` can name the exact field that differs.
- `render` must draw with whatever Draw2D it receives, including a stub that renders nothing. `desync` calls `render(stubDraw)` to prove rendering leaves state alone; a render that skips itself when there is no real renderer makes that check pass without checking anything. `dotframe doctor` fails `sim:render` when render makes no draw calls.
- Declare `rollbackWindow` (the most frames your netplay rolls back) so `desync` warns when a link needs more.

Prove a check can fail before trusting its green: make render change one field on purpose, run `desync`, and confirm it fails on peer 1 and names that field. Then revert.

## Trust ladder

| Level | Commands | Rule |
|---|---|---|
| Read | `sim`, `snap`, `replay verify`, `desync`, `doctor`, `config get`, `skills` | Run freely |
| Local write | `build`, `replay record`, `config set`, `new`, `dev`, `doctor --fix` | Run freely, report what changed |
| External | `deploy`, `relay deploy`, `device install` | Run `--dry-run` first, show the plan, rerun with `--yes` only after the human approves |

`--yes` is the human's approval, not yours. Never add it on your own.

## Output and errors

Pass `--json` and read `ok`. Errors look like `{"ok": false, "error": {"code", "message", "fix", "skill"}}`. Apply `fix`, and when it is not obvious run `dotframe skills get <skill>`. Exit codes: 0 ok, 1 failure, 2 approval required. Full list: `dotframe skills get core --full`.

## Engine modules agents reach for

- `dotframe/src/detmath`: deterministic sin, cos, tan, atan, atan2, exp, log, pow, hypot for simulation code.
- `dotframe/src/checksum`: a fixed-order checksum over numbers.
- `dotframe/src/netplay` and `dotframe/src/relay-client`: rollback netplay and the relay connection (see netplay); `dotframe/src/native/relay` on native.
- `dotframe/src/ui`: buttons and arrow rows laid out once for drawing and hit-testing (`column`, `hit`, `drawUi`, `moveFocus`), taps from mouse and touch (`createTap`), and `createReleaseGate` so the press that starts a match does not reach gameplay.
- Web: `run(window, setup, { fit: "window" })` fills the browser window; `Draw2D.resize(w, h)` lets the logical canvas follow `gpu.aspect()`.

## Other guides

`dotframe skills list`. Load the one that matches the task: netplay, export-web, discord, ios, macos, relay, game-design, assets.
