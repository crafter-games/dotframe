---
name: relay
description: Deploy and place the WebSocket relay that pairs netplay peers. Use when online play is laggy, choosing a relay region, or redeploying the relay.
---
# relay

The relay forwards inputs between peers in a room. It does no simulation, so its only job is to be close to the players: every input crosses peer to relay to peer.

```sh
dotframe relay deploy --dry-run
dotframe relay deploy --yes                 # dokploy: redeploys the compose stack
dotframe relay deploy --region eze --yes    # fly: Buenos Aires; scl is Santiago
```

- Providers live in `relay` in dotframe.json: `{"provider": "dokploy", "compose": "<id>"}` or `{"provider": "fly", "app": "...", "config": "fly.toml", "region": "eze"}`. Dokploy runs on one fixed VPS and ignores regions.
- Measure before and after: in-game ping, rollbacks per minute, stalls. A relay in Europe gave 474 ms between two players in South America.
- Dokploy applies compose domain changes only on redeploy.
- After moving the relay, update the Discord `/relay` URL mapping if the host changed.
