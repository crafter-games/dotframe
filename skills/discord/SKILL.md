---
name: discord
description: Run a dotframe web build as a Discord Activity. Use when setting up or debugging a Discord Activity, its URL mappings, the relay path, or stale bundles inside Discord.
---
# discord

A Discord Activity is the web build served through Discord's proxy, so `dotframe build discord` and `dotframe deploy discord` use the web pipeline (see `export-web`).

- URL mappings in the Discord developer portal: `/` to the web deployment, `/relay` to the relay. The game connects to `wss://<activity host>/relay`, never to an outside host (the proxy blocks it).
- The room is the Activity instance id, so everyone in the same launch meets.
- Discord caches aggressively. Hashed bundle names plus a no-cache `index.html` fix it; if a change does not show up, check the bundle hash in the served page first.
- Test 1P vs CPU first, then online. Online quality is bound by relay latency (see `relay`); run `dotframe desync --latency <measured ping>` before blaming the netcode.
