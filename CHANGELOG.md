# Changelog

## 0.1.3

Fixes from the Craft Ones port dogfood.

- Numeric and duration flags are validated: `--latency abc`, `--frames abc` and friends fail with `BAD_ARG` instead of a false green.
- `snap` requires `--frame` and builds in a temp directory, never in the repo.
- `new` skips `git init` inside an existing repo, copies template subfolders, and names the real cause when bun's minimum release age blocks a fresh dotframe.
- `deploy --dry-run` counts every file in the build, not the top-level entries.
- `dev` serves `index.html` with `Cache-Control: no-cache`, like production.
- Templates: content-hashed web build with a no-cache `vercel.json`, `tsconfig.json` with `@webgpu/types`, and a declared `rollbackWindow`.
- Engine: `src/web/run.ts` typechecks on TypeScript 5.9 and with Bun's types loaded.
- `doctor` fails when the deploy scope is a template placeholder, and when `render()` draws nothing with a stub Draw2D (which makes `desync` blind).
- `desync` warns when rollbacks exceed the sim's new optional `rollbackWindow`.
- Per-command help (`dotframe <command> --help`); `config set` keeps short objects and arrays on one line.
- Skills: render purity with a stub Draw2D and the forced-red check (core), rollback window (netplay), SVG rasterizing (assets).

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
