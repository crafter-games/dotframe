<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/dotframe-dark.svg">
  <img alt="dotframe" src="assets/logo/dotframe-light.svg" width="72">
</picture>

# dotframe

The game engine your agent can play.

[![npm](https://img.shields.io/npm/v/dotframe?style=flat-square&labelColor=17140f&color=6b2cf5)](https://www.npmjs.com/package/dotframe)
[![downloads](https://img.shields.io/npm/dm/dotframe?style=flat-square&labelColor=17140f&color=6b2cf5)](https://www.npmjs.com/package/dotframe)
[![license](https://img.shields.io/npm/l/dotframe?style=flat-square&labelColor=17140f&color=6b2cf5)](LICENSE)

[dotframe.crafter.games](https://dotframe.crafter.games)

</div>

One TypeScript codebase for the web (WebGPU, with a Canvas 2D fallback for 2D games), iPhone, macOS, Windows and Discord. Native builds compile with [scriptc](https://scriptc.dev), so there is no JavaScript engine in the binary. Every frame is deterministic, so an agent can play the game headless, render any frame, and catch a netplay desync.

## Install

```sh
npm i -g dotframe                      # needs Bun on PATH
npx skills add crafter-games/dotframe  # the agent skill
```

## Quick start

```sh
dotframe new my-game --template blank  # fighter, platformer, blank
cd my-game && dotframe dev
```

Agents start with `dotframe skills get core`.

## CLI

```sh
dotframe sim --mash 7 --frames 600 --json   # headless run: state + checksum
dotframe snap --frame 300 --mash 7          # render one frame through WebGPU
dotframe replay record replays/a.json --mash 7
dotframe replay verify replays/*.json       # replays are the tests
dotframe desync --latency 120ms --jitter 30ms
dotframe build web|ios|macos|discord
dotframe deploy web --prod --dry-run        # external actions need --yes
dotframe doctor --fix
```

Every command takes `--json`. Errors carry a `code`, a `fix`, and the `skill` to read.

A game opts in with a `dotframe.json` (targets, deploy, relay) and a `sim` module that default-exports `defineSim` from `src/sim.ts`.

## Made with dotframe

[Espresso perfecto](https://github.com/crafter-games/espresso) · [Craft Ones](https://github.com/crafter-games/craft-ones) · [Crafter Smash](https://github.com/crafter-games/crafter-smash-dotframe) · [The Ones](https://github.com/crafter-games/the-ones-game)

Shipped one? Add the badge:

<a href="https://dotframe.crafter.games">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/badge/made-with-dotframe-dark.svg">
    <img alt="Made with dotframe" src="assets/badge/made-with-dotframe-light.svg" height="32">
  </picture>
</a>

```html
<a href="https://dotframe.crafter.games">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/crafter-games/dotframe/main/assets/badge/made-with-dotframe-dark.svg">
    <img alt="Made with dotframe" src="https://raw.githubusercontent.com/crafter-games/dotframe/main/assets/badge/made-with-dotframe-light.svg" height="32">
  </picture>
</a>
```

## More

- [docs/internals.md](docs/internals.md): source layout, vendored SDL3 and wgpu-native, building examples by hand
- [CHANGELOG.md](CHANGELOG.md)

MIT
