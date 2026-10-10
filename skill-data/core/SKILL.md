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
4. `dotframe replay verify replays/*.json`: golden replays must still pass. If a change is meant to alter gameplay, re-record them on purpose and say so. Before shipping to a native target, add `--native` (or run `doctor`): the same replays on the scriptc build, where code Bun accepts can abort.
   - A change that adds state or touches the checksum without moving gameplay fails verify too. Show that it did not move anything, then re-record: `dotframe replay rebase replays/*.json` runs each replay on the sim at HEAD and on the working tree and re-records only the ones whose final `state()` matches (fields the change added are allowed; `--ignore state.x` for intended changes). It reports the rest as MOVED with the first differing field and exits 1.
5. For online games, `dotframe desync` (see `dotframe skills get netplay`).
6. Only then `dotframe build <target>`.

Performance: `dotframe perf --frames 600 --options '<json>'` reports load time, the requestAnimationFrame interval and the CPU time of step and render (p50, p95, max), plus any frame over 50 ms. It measures this machine's browser, capped at its vsync, so a phone needs its own run. Another agent-browser tab in front throttles the page to 1 fps: rerun before trusting a row of 1000 ms hitches.

Never claim a visual change works from the JSON alone. Snap it and look.

`sim` and `replay` stop when `over()` turns true. Pass `--through-over` to keep stepping into results and rematch flows.

## agent-browser

`snap` drives agent-browser in its own session (`dotframe-snap`), writes to an absolute path, and checks the PNG size. When you drive agent-browser yourself, always pass `--session <name>` and absolute output paths: one daemon serves the whole machine, so a relative `screenshot out.png` lands in whatever directory the daemon started in (often another repo), and viewports can leak between sessions.

## Inputs

- `--mash <seed>`: random mashing players, new input every 6 frames. Good default for smoke tests.
- `--inputs file.jsonl`: one line per frame, `[p0, p1]`, or sparse `{"frame": 120, "inputs": [p0, p1]}` held until the next line. Each input is the game's JSON shape (for example `{"right": true, "attack": true}`) or an already-encoded number.
- `--seed <n>` seeds the simulation; `--options '<json>'` overrides match options (stage, characters, stocks).
- `--every <n>` on `sim` adds a checksum trace.
- `--plan plan.json` on `replay record` walks and aims player 0 for you, for first- and third-person games that declare `pilot` (see below): `{"go": [x, z]}`, `{"look": [x, y, z]}`, `{"press": frames}`, `{"wait": frames}` or `{"wait": {"until": "story.phase", "is": "day"}}`, and `{"expect": "story.seen", "is": "collar"}` (an array passes when it contains the value); any step can hold named buttons with `"with": ["crouch"]`. Steering reads the game's pose every frame, so the plan survives a moved spawn or a new walk speed; prefer it to hand-tuned `--inputs` and to one-off route scripts. A failed step names its frame and writes nothing.

## The Sim contract

`dotframe.json` names a module (`"sim": "sim.ts"`) whose default export is `defineSim({...})` from `dotframe/src/sim`: `players`, `window`, `options`, `neutral`, `encode`, `random`, and `create(platform)` returning `start`, `step`, `checksum`, `state`, `over`, `save`, `restore`, and optionally `inspect` and `render`. Rules that keep it honest:

- All simulation state changes only inside `step`. `render` reads, never writes (no spawning particles or texts from draw code).
- Randomness comes from a seeded generator that `save`/`restore` capture.
- `inspect` returns the whole state graph so `desync` can name the exact field that differs.
- `render` must draw with whatever Draw2D it receives, including a stub that renders nothing. `desync` calls `render(stubDraw)` to prove rendering leaves state alone; a render that skips itself when there is no real renderer makes that check pass without checking anything. `dotframe doctor` fails `sim:render` when render makes no draw calls.
- For `replay record --plan`, declare `pilot` on the Sim (`yawTo(dx, dz)`, `turn` radians per frame, `input({forward, yaw, pitch, use, buttons})` returning the encoded input) and `pose()` on the run (player 0's eye position, yaw and pitch). The game owns its angle conventions and input encoding; the CLI only aims and walks.
- Declare `rollbackWindow` (the most frames your netplay rolls back) so `desync` warns when a link needs more.

Prove a check can fail before trusting its green: make render change one field on purpose, run `desync`, and confirm it fails on peer 1 and names that field. Then revert.

## Trust ladder

| Level | Commands | Rule |
|---|---|---|
| Read | `sim`, `snap`, `compare`, `replay verify`, `desync`, `doctor`, `config get`, `skills` | Run freely |
| Local write | `build`, `replay record`, `replay rebase`, `assets slim`, `assets font`, `config set`, `new`, `dev`, `doctor --fix` | Run freely, report what changed |
| External | `deploy`, `relay deploy`, `device install` | Run `--dry-run` first, show the plan, rerun with `--yes` only after the human approves |

`--yes` is the human's approval, not yours. Never add it on your own.

## Output and errors

Pass `--json` and read `ok`. Errors look like `{"ok": false, "error": {"code", "message", "fix", "skill"}}`. Apply `fix`, and when it is not obvious run `dotframe skills get <skill>`. Exit codes: 0 ok, 1 failure, 2 approval required. Full list: `dotframe skills get core --full`.

## 3D games

`render(draw)` stays the one entry point. Build the 3D scene in `create(platform)` with `createRenderer(platform.gpu)` (it also works on the headless stub GPU, so `doctor`'s purity check runs the 3D path), then in render queue it under the HUD:

```ts
render: (draw) => {
  draw.scene(renderer.draws(world, camera, environment)); // 3D first, same frame
  drawHud(game, draw);                                    // 2D on top
},
```

- `Environment`: ambient, a directional `sun`, point `lights`, up to `MAX_SPOTS` `spots`, `fog` (with `scatter` and `volumes`) and `exposure` (ACES). Pass every light: the renderer keeps the `MAX_LIGHTS` that matter for the view (lit, in the frustum, nearest the eye), so no hand budgeting. Limits that drop things (spots, fog volumes, joints) warn once. `MeshRef.texture` maps triplanar in world space (`tile` = units per repeat), so boxes and terrain need no UVs; `emissive` adds unlit color.
- Particles: `Environment.glow` draws billboards additively (fire, sparks, lanterns); `Emitter.colors` is a color ramp over the life, `Emitter.radius` a spawn sphere.
- Materials: `Renderer.createMaterial(wgsl)` with `fn surface(s)` (Godot's `fragment()`) and optionally `fn vertex(position, time, params0, params1) -> vec3f` (Godot's `vertex()`) to move the mesh before transform and skinning.
- Culling is automatic: static meshes out of view or scaled to zero are skipped. To hide a prop, scale it to zero. Skinned meshes are always drawn.
- `box()` is side 1 (-0.5..0.5): scale is the full size.
- Textures for snap: `platform.image(bytes, smooth)` decodes PNG and JPEG when frames are drawn; set `clear` on the Sim to your sky color.
- First person: `input.look()` gives mouse movement; `run(..., { pointerLock: true })` on the web. Native returns zero for now.
- iOS has no promises: give the scene a sync loader for `main.ios.ts` (see the `ios` skill).

## Engine modules agents reach for

- `dotframe/src/detmath`: deterministic sin, cos, tan, atan, atan2, exp, log, pow, hypot for simulation code.
- `dotframe/src/checksum`: a fixed-order checksum over numbers.
- `dotframe/src/netplay` and `dotframe/src/relay-client`: rollback netplay and the relay connection (see netplay); `dotframe/src/native/relay` on native.
- `dotframe/src/ui`: buttons and arrow rows laid out once for drawing and hit-testing (`column`, `hit`, `drawUi`, `moveFocus`), taps from mouse and touch (`createTap`), and `createReleaseGate` so the press that starts a match does not reach gameplay. `UiStyle.align: "left"` with `pad` lays out settings lists (label at the edge, value and arrows on the right).
- `dotframe/src/rig`: posing a skeleton by hand: `createRig`, `solve`, `turn`, `aim`, `headLook`, `stare`, `snap`, `follow`, `twoBoneIk` (walkers and creatures with no clips), `lockRoot`, `eulerYXZ`.
- Music: `playMusic(track, loop, volume, channel)` and `setMusicVolume`, `pauseMusic`, `stopMusic` take a channel (0 to `MUSIC_CHANNELS - 1`, default 0); the channels stream together, so a layered score crossfades by setting volumes.
- `Storage` persists on every target, iOS included (the app's preferences): save games there.
- Web input: a key tapped between two frames reads as down for one frame, so menus and scripted browser presses are not lost.
- Web: `run(window, setup, { fit: "window" })` fills the browser window; `Draw2D.resize(w, h)` lets the logical canvas follow `gpu.aspect()`.

## Other guides

`dotframe skills list`. Load the one that matches the task: netplay, export-web, discord, ios, macos, relay, game-design, assets.

## Porting a game from another engine

`dotframe compare --frame <n> --ref <png>` puts the port's frame next to the original's picture of the same shot (compare.png: port, reference, difference x4) with the mean difference and a 3x3 grid of where the port is darker or brighter. Add `"reference": {"command": [...]}` to dotframe.json, with `{shot}` and `{out}` placeholders, to have compare capture the original itself (for example a Godot script that loads that moment). Judge the picture, not the number: grain, tape noise and animation phase keep the difference above zero.
