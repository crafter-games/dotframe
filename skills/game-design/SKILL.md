---
name: game-design
description: Start and structure a new dotframe game. Use when scaffolding a game, choosing a template, or organizing game state so it stays deterministic and testable.
---
# game-design

```sh
dotframe new my-game --template fighter    # or platformer, blank
cd my-game && dotframe sim --mash 7 --json && dotframe dev
```

Templates: `fighter` (two players, knockback, stocks), `platformer` (one player, one-way platforms, coins), `blank` (two moving squares). Each one has:

- `src/game.ts`: pure state plus `createGame`, `step`, `render`, `encode`, `checksum`, `state`, `snapshot`.
- `sim.ts`: the Sim contract over game.ts. The CLI drives it.
- `main.web.ts`: keyboard to encoded input, fixed 60 Hz steps, render.
- `dotframe.json`, `AGENTS.md`, a stub skill, `replays/`.

## Shape the game for agents

- Keep all state in one plain object graph. Then `structuredClone` is a snapshot and `inspect` is free.
- Encode input as a small number per player. Replays, netplay and mashing all reuse it.
- Make `state()` the summary a reviewer needs: positions, scores, who won. Agents read it after every sim.
- Record a golden replay as soon as a mechanic works (`dotframe replay record replays/<name>.json --mash 7`) and keep `bun test` running them.
- Add `--options` for anything you want to test in isolation (stage, character, one stock).

See `dotframe skills get game-design --full` for a sim.ts walkthrough.
