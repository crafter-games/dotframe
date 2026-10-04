# Changelog

## 0.1.2

- `npx skills add crafter-games/dotframe` installs a `dotframe` discovery skill that points agents at `dotframe skills get core`. The guides served by the CLI moved to `skill-data/`, so they are not installed as separate skills.

## 0.1.1

- First release published from CI through npm trusted publishing, with provenance.

## 0.1.0

First npm release: the engine plus the agent-first `dotframe` CLI.

- `sim`, `snap`, `replay record/verify`, `desync`: play a game headless or render a frame through WebGPU, deterministically, through the Sim contract in `src/sim.ts`.
- `desync` compares the full state graph (`inspect()`) at checkpoints and names the first differing path, so render code that changes simulation state shows up before a real match.
- `build`, `deploy`, `relay deploy`, `device install`, `doctor`, `config`: targets live in `dotframe.json`; external actions need `--yes` and preview with `--dry-run`.
- `skills list/get/path`: nine guides bundled with the CLI version (core, netplay, export-web, discord, ios, macos, relay, game-design, assets).
- `new` with fighter, platformer, and blank templates, and `dev`.
