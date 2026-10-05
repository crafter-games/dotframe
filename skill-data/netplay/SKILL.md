---
name: netplay
description: Rollback netplay for dotframe games. Use when building or debugging online play, a desync, rollbacks, input delay, or render code that might change simulation state.
---
# netplay

## The engine

`dotframe/src/netplay` is a game-agnostic rollback engine: `createRollback({ sim, transport, localPort, neutral, inputDelay, maxRollback, resimulating })`, where `sim` is anything with `step(inputs)`, `save()`, `restore(s)` and `checksum()` (the Sim contract's shape). Call `tick(localInput)` once per fixed step; it returns whether a frame was simulated. `stats()` has rollbacks, stalls, round trip and the first desynced frame; `sumAt(frame)` gives this peer's checksum.

`dotframe/src/relay-client` (web only) connects to a relay: `connectRelay(url, room)` gives `status()`, `slot()`, game messages (`send`/`receive`) and the `transport` for createRollback. Use `dotframe/src/checksum` for checksums and `dotframe/src/detmath` for any trig, exp, log or pow in simulation code.

```sh
dotframe relay serve                  # local relay on :8787, same protocol as production
dotframe play --online --frames 900   # two browsers, scripted match, checksums compared, screenshots saved
```

`play --online` needs the web entry to honor `?room=`, `?relay=` and `?mash=<seed>` and to publish `globalThis.__dotframe = { frame, confirmed, status, sums }` (sums: checksum per 30th confirmed frame). The templates show it.

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

- Simulation code uses `dotframe/src/detmath` (dsin, dcos, datan2, dexp, dlog, dpow, ...), never `Math.sin` and friends or `**`: those differ in the last bits between engines and operating systems, so peers and replays drift (Craft Ones' replays diverged between macOS and Linux at frame 120). `dotframe doctor` warns about them (`sim:math`); mark render-only lines with `// dotframe-allow-math`. A replay passing on one machine proves nothing about another: run CI on a second OS.
- `desync` reports `restoreMs` early vs late; it warns when late restores cost more than twice the early ones (a heuristic for restore that replays from an earlier frame, which passes desync but stalls real rollbacks late in a match).
- Build checksums from numbers in a fixed order, never from `JSON.stringify`: native builds can order keys differently from JavaScript, so a web peer and a native peer would report false desyncs.

- The camera, effects, and HUD timers are simulation state if the simulation ever reads them. Update them once per step, never per drawn frame.
- Render must restore any random state it uses, or use a separate visual generator.
- Input delay (`--delay`, default 2) trades latency for fewer rollbacks.
- After a fix, rerun desync across seeds, then `dotframe replay verify`, then test a real match.
