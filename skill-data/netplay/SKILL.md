---
name: netplay
description: Rollback netplay for dotframe games. Use when building or debugging online play, a desync, rollbacks, input delay, or render code that might change simulation state.
---
# netplay

dotframe online play is rollback netcode: each peer predicts the remote input (repeat the last one), simulates ahead, and when the real input arrives and differs, restores a snapshot and resimulates. It only works if every peer computes bit-identical state from the same inputs.

## Test before going online

```sh
dotframe desync --latency 120ms --jitter 30ms --frames 3000 --mash 7 --json
```

It runs a reference simulation and two peers over a deterministic simulated link. Peer 1 also renders 3 times per step (`--renders`), like a 144 Hz screen. Read per peer:

- `firstDivergentFrame`: the checksum differed. A rollback or determinism bug.
- `firstStateDifference`: `{frame, path}` of the first field that differs at a checkpoint (`--every 30`). Catches state the checksum does not cover. Needs `inspect()` in the sim.
- `rollbacks`, `maxRollbackFrames`: how hard the link worked. With `rollbackWindow` in the sim, `warnings` says when a link needs deeper rollbacks than the game allows (real play would stall).

Long runs: rendering on the stub costs whatever the game's render costs. `--renders 0` speeds desync up but turns off the render purity half of the check; use it for rollback depth or latency sweeps, and keep at least one run with renders. `dotframe doctor` also checks render purity on its own, in about a second.

Run several seeds and a high latency (474 ms is what a transatlantic relay measured). A pass on one seed proves little.

## Reading a failure

- Only peer 1 differs: rendering changes state. Look for draw code that spawns effects, advances timers, moves the camera, or consumes the seeded random. Move it into `step`.
- Both peers differ: `save`/`restore` misses state, or something non-deterministic (Math.random, Date, Map iteration over unordered keys, floating state touched outside step).
- The path is the lead. `state.fx.texts.0.x: extra` means a text exists on one side only: find who pushes into `fx.texts` outside step.

## Rules

- Build checksums from numbers in a fixed order, never from `JSON.stringify`: native builds can order keys differently from JavaScript, so a web peer and a native peer would report false desyncs.

- The camera, effects, and HUD timers are simulation state if the simulation ever reads them. Update them once per step, never per drawn frame.
- Render must restore any random state it uses, or use a separate visual generator.
- Input delay (`--delay`, default 2) trades latency for fewer rollbacks.
- After a fix, rerun desync across seeds, then `dotframe replay verify`, then test a real match.
