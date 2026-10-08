# __NAME__

A dotframe game. Run `dotframe skills get core` before changing anything; it explains the edit, sim, snap, replay loop.

- Game logic: `src/game.ts` (pure state, `step`, `render`). The sim contract: `sim.ts`.
- Check a change: `dotframe sim --mash 7 --frames 600 --json`, then `dotframe snap --frame 300 --mash 7`.
- Golden replays: `replays/*.json`, verified by `bun run test` (`bun test` is Bun's test runner and skips the script).
