---
name: export-web
description: Build and deploy the web target of a dotframe game. Use when bundling for the browser, serving locally, or deploying to Vercel.
---
# export-web

```sh
dotframe build web --json            # runs targets.web.steps
dotframe dev                         # build, serve on :5173, rebuild on change
dotframe deploy web --dry-run        # show the plan
dotframe deploy web --prod --yes     # only after the human approved the plan
```

## Rules

- Deploy only the built folder (`targets.web.out`). The CLI refuses a folder that looks like source (repo root, `.git`, `dotframe.json`): that mistake once put the wrong game in production.
- Do not connect the repo to Vercel's Git integration for these games. A push deploys the repo root.
- Templates ship `scripts/build-web.ts`, which does both of the next points. Keep it when you change the build.
- Content-hash the bundle (`main.<hash>.js`) and serve `index.html` with `Cache-Control: no-cache`, so browsers and Discord's proxy never run a stale build.
- `deploy` without `--prod` makes a preview. Prefer it for checks.
- Verify a deploy by opening the URL with agent-browser and taking a screenshot, not by the exit code.

## Docker and Dokploy (VPS)

```sh
dotframe deploy init web --provider dokploy     # deploy/Dockerfile.web, Dockerfile.relay, nginx.conf, compose.yaml
dotframe doctor --docker                        # builds the web image locally, as the server will
dotframe config set targets.web.deploy.compose '"<compose id>"'   # vps compose list
dotframe deploy web --dry-run && dotframe deploy web --yes
```

- Images are pinned: bun from `packageManager` (game or repo root, else the local bun) and the relay's dotframe from the version installed in the game. Rerun `deploy init --yes` after bumping either.
- The web image installs the tools in `requires` (dotframe.json, for example `["ffmpeg"]`) and builds with dotframe; the relay image runs `dotframe relay serve`. The build context is the repo root, so monorepo ports see workspace code.
- In Dokploy, route the domain's `/` to service `web` (port 80) and `/relay` to service `relay` (port 8787). For Discord, map `/` and `/relay` to that host.
- Dokploy builds the pushed branch, not your working tree: deploy warns about unpushed or uncommitted work. On failure it returns the build log (through `vps compose logs`).
- Hash bundles with a tool that exists in the image: `shasum` is missing on Debian images (use `sha256sum` or Bun's hashing, as `scripts/build-web.ts` does).
