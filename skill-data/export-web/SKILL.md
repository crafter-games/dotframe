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
