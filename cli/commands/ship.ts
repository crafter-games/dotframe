import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Command, type Ctx, exec, gate, loadConfig, print, runSteps, target, which } from "../lib";

const skillFor = (t: string): string => (t === "web" ? "export-web" : t);

function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1), 0);
}

// Paths marked local-only (unlicensed for distribution) that would ship with a release build.
function licenseBlockers(root: string, paths: string[]): string[] {
  return paths.filter((p: string): boolean => {
    const full = resolve(root, p);
    return existsSync(full) && (!statSync(full).isDirectory() || readdirSync(full).length > 0);
  });
}

export async function build(ctx: Ctx, name: string | undefined, release: boolean): Promise<void> {
  if (!name) throw new CliError("MISSING_ARG", "build needs a target", "dotframe build web");
  const config = loadConfig();
  const t = target(config, name);
  if (release) {
    const blocked = licenseBlockers(config.root, config.assets?.localOnly ?? []);
    if (blocked.length > 0) throw new CliError("ASSETS_LOCAL_ONLY", `release build would ship assets marked local-only: ${blocked.join(", ")}`, "replace them with licensed assets, then remove them from assets.localOnly", "assets");
  }
  const steps = await runSteps(ctx, config.root, t.steps, skillFor(name));
  const artifact = t.out ?? t.app;
  print(ctx, { target: name, dryRun: ctx.dryRun, steps, artifact: artifact ? resolve(config.root, artifact) : null }, (): string =>
    [...steps.map((s): string => (ctx.dryRun ? s.tail : `ok ${s.label} (${s.ms} ms)`)), artifact ? `artifact: ${artifact}` : ""].filter(Boolean).join("\n"),
  );
}

export async function deploy(ctx: Ctx, name: string | undefined, prod: boolean): Promise<void> {
  if (!name) throw new CliError("MISSING_ARG", "deploy needs a target", "dotframe deploy web --prod --dry-run");
  const config = loadConfig();
  const t = target(config, name);
  const skill = skillFor(name);
  if (!t.deploy || !t.out) throw new CliError("NO_DEPLOY", `target "${name}" has no deploy provider or out dir`, `add "out" and "deploy": {"provider": "vercel", ...} to the target`, skill);
  const out = resolve(config.root, t.out);
  // The 2026-10-03 incident: deploying the repo root put the wrong game in production.
  if (out === config.root || existsSync(join(out, "dotframe.json")) || existsSync(join(out, ".git"))) {
    throw new CliError("DEPLOY_SOURCE_DIR", `${t.out} looks like source, not a build`, "point out at the built folder (e.g. port/dist/web)", skill);
  }
  if (!existsSync(join(out, "index.html"))) throw new CliError("NOT_BUILT", `${t.out}/index.html is missing`, `dotframe build ${name}`, skill);
  if (t.deploy.scope === "your-vercel-team") throw new CliError("CONFIG_PLACEHOLDER", `targets.${name}.deploy.scope is still the template placeholder`, `dotframe config set targets.${name}.deploy.scope '"<team>"'`, skill);
  const argv = ["vercel", "deploy", ...(prod ? ["--prod"] : []), "--yes", "--scope", t.deploy.scope, "--name", t.deploy.project];
  const plan = { target: name, provider: t.deploy.provider, project: `${t.deploy.scope}/${t.deploy.project}`, dir: out, production: prod, files: countFiles(out), command: argv.join(" ") };
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, ...plan }, (): string => `would deploy ${out} to ${plan.project}${prod ? " (production)" : " (preview)"}\n  ${plan.command}`);
    return;
  }
  gate(ctx, `deploy ${name}${prod ? " to production" : ""}`, skill);
  if (!which("vercel")) throw new CliError("TOOL_MISSING", "vercel CLI not found", "npm i -g vercel", skill);
  const r = await exec(ctx, config.root, { label: "vercel deploy", argv, cwd: out });
  if (r.code !== 0) throw new CliError("DEPLOY_FAILED", r.tail, "vercel whoami; vercel switch " + t.deploy.scope, skill);
  const url = r.tail.match(/https:\/\/\S+\.vercel\.app/g)?.pop() ?? null;
  print(ctx, { ...plan, url, ms: r.ms }, (): string => `deployed ${url ?? "(url not found in output)"}`);
}

export async function relay(ctx: Ctx, region: string | undefined): Promise<void> {
  const config = loadConfig();
  const r = config.relay;
  if (!r) throw new CliError("NO_RELAY", `dotframe.json has no "relay"`, `add {"provider": "dokploy", "compose": "<id>"} or {"provider": "fly", "app": "...", "config": "fly.toml"}`, "relay");
  let command: Command;
  if (r.provider === "dokploy") {
    if (region) throw new CliError("UNSUPPORTED", "dokploy runs on one fixed VPS; --region needs the fly provider", "", "relay");
    command = { label: "dokploy redeploy", argv: ["vps", "-y", "compose", "redeploy", r.compose] };
  } else {
    command = { label: "fly deploy", argv: ["fly", "deploy", "--config", r.config, "--app", r.app, "--primary-region", region ?? r.region ?? "eze", "--yes"] };
  }
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, provider: r.provider, command: command.argv.join(" ") }, (): string => `would run: ${command.argv.join(" ")}`);
    return;
  }
  gate(ctx, "relay deploy", "relay");
  if (!which(command.argv[0])) throw new CliError("TOOL_MISSING", `${command.argv[0]} not found`, r.provider === "fly" ? "brew install flyctl && fly auth login" : "bun add -g vps CLI and log in", "relay");
  const res = await exec(ctx, config.root, command);
  if (res.code !== 0) throw new CliError("DEPLOY_FAILED", res.tail, "", "relay");
  print(ctx, { provider: r.provider, ms: res.ms }, (): string => `relay deployed via ${r.provider}`);
}

export async function device(ctx: Ctx, name: string): Promise<void> {
  const config = loadConfig();
  const t = target(config, name);
  if (!t.app || !t.device) throw new CliError("NO_DEVICE", `target "${name}" needs "app" and "device" in dotframe.json`, "xcrun devicectl list devices", "ios");
  const app = resolve(config.root, t.app);
  const argv = ["xcrun", "devicectl", "device", "install", "app", "--device", t.device, app];
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, command: argv.join(" ") }, (): string => `would run: ${argv.join(" ")}`);
    return;
  }
  gate(ctx, `install ${name} on device ${t.device}`, "ios");
  if (!existsSync(app)) throw new CliError("NOT_BUILT", `${t.app} is missing`, `dotframe build ${name}`, "ios");
  const r = await exec(ctx, config.root, { label: "devicectl install", argv });
  if (r.code !== 0) throw new CliError("INSTALL_FAILED", r.tail, "unlock the phone, trust this Mac, enable Developer Mode", "ios");
  print(ctx, { device: t.device, app, ms: r.ms }, (): string => `installed ${app} on ${t.device}`);
}
