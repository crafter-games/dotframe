---
name: dotframe
description: Agent-first CLI for the dotframe game engine. Use when building, testing, or exporting a dotframe game: creating a game from a template, simulating or replaying frames headless, rendering a frame to check what a player sees, debugging rollback netplay desyncs, or building and deploying for web, Discord Activities, iOS, and native macOS or Windows. Triggers include "make a game", "dotframe", "simulate the match", "snap a frame", "replay", "desync", "netplay", "build for iOS", "deploy the game", or any repo with a dotframe.json.
allowed-tools: Bash(dotframe:*), Bash(npx dotframe:*), Bash(bunx dotframe:*)
hidden: true
---

# dotframe

TypeScript game engine with an agent-first CLI. The simulation is deterministic, so an agent can play a game without a screen, render one frame through the real WebGPU renderer, and catch netplay desyncs before a real match.

Install: `npm i -g dotframe` (needs Bun on PATH)

## Start here

This file is a discovery stub, not the usage guide. Before running any `dotframe` command, load the actual workflow content from the CLI:

```bash
dotframe skills get core             # start here: the edit, sim, snap, replay loop, the Sim contract, the trust ladder
dotframe skills get core --full      # include the full error code reference
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task calls for it:

```bash
dotframe skills get netplay        # rollback netcode, desync, render purity
dotframe skills get game-design    # new games, templates, shaping state for agents
dotframe skills get export-web     # web build, local dev, Vercel deploys
dotframe skills get discord        # Discord Activities, URL mappings, stale bundles
dotframe skills get ios            # iPhone builds, vendor links, signing, device install
dotframe skills get macos          # native binaries with scriptc
dotframe skills get relay          # relay placement and deploys
dotframe skills get assets         # licensing and local-only assets before a release
```

Run `dotframe skills list` to see everything available on the installed version. Errors in `--json` mode name the skill to read in their `skill` field.
