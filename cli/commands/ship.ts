import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIos } from "../ios";
import { deployDokploy } from "./docker";
import { buildNative, ENGINE, type NativePlatform, vendorDir, vendorStatus } from "../native";
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
  if (t.native?.platform === "ios") {
    const r = await buildIos(ctx, config.root, config.name, name, t.native);
    if (ctx.dryRun) return;
    print(ctx, { target: name, steps: r.steps.map(({ output: _o, ...s }) => s), artifact: r.app, log: r.log }, (): string => `artifact: ${r.app}\nlog: ${r.log}`);
    return;
  }
  if (t.native) {
    const r = await buildNative(ctx, config.root, config.name, name, t.native);
    if (ctx.dryRun) return;
    print(ctx, { target: name, steps: r.steps.map(({ output: _o, ...s }) => s), artifact: r.binary, log: r.log }, (): string => `artifact: ${r.binary}\nlog: ${r.log}`);
    return;
  }
  if (!t.steps) throw new CliError("BAD_CONFIG", `target "${name}" needs "steps" or "native"`, "see dotframe skills get macos", skillFor(name));
  const steps = (await runSteps(ctx, config.root, t.steps, skillFor(name))).map(({ output: _o, ...s }) => s);
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
  if (!t.deploy || !t.out) throw new CliError("NO_DEPLOY", `target "${name}" has no deploy provider or out dir`, `add "out" and "deploy": {"provider": "vercel", ...}, or run dotframe deploy init ${name} --provider dokploy`, skill);
  // Dokploy builds the image from the repo, so there is no local build folder to check.
  if (t.deploy.provider === "dokploy") return deployDokploy(ctx, config, name, t.deploy.compose);
  const vercel = t.deploy;
  const out = resolve(config.root, t.out);
  // The 2026-10-03 incident: deploying the repo root put the wrong game in production.
  if (out === config.root || existsSync(join(out, "dotframe.json")) || existsSync(join(out, ".git"))) {
    throw new CliError("DEPLOY_SOURCE_DIR", `${t.out} looks like source, not a build`, "point out at the built folder (e.g. port/dist/web)", skill);
  }
  if (!existsSync(join(out, "index.html"))) throw new CliError("NOT_BUILT", `${t.out}/index.html is missing`, `dotframe build ${name}`, skill);
  if (vercel.scope === "your-vercel-team") throw new CliError("CONFIG_PLACEHOLDER", `targets.${name}.deploy.scope is still the template placeholder`, `dotframe config set targets.${name}.deploy.scope '"<team>"'`, skill);
  const argv = ["vercel", "deploy", ...(prod ? ["--prod"] : []), "--yes", "--scope", vercel.scope, "--name", vercel.project];
  const plan = { target: name, provider: vercel.provider, project: `${vercel.scope}/${vercel.project}`, dir: out, production: prod, files: countFiles(out), command: argv.join(" ") };
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, ...plan }, (): string => `would deploy ${out} to ${plan.project}${prod ? " (production)" : " (preview)"}\n  ${plan.command}`);
    return;
  }
  gate(ctx, `deploy ${name}${prod ? " to production" : ""}`, skill);
  if (!which("vercel")) throw new CliError("TOOL_MISSING", "vercel CLI not found", "npm i -g vercel", skill);
  const r = await exec(ctx, config.root, { label: "vercel deploy", argv, cwd: out });
  if (r.code !== 0) throw new CliError("DEPLOY_FAILED", r.tail, "vercel whoami; vercel switch " + vercel.scope, skill);
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
  // Native iOS targets build into dist/<target>/<Scheme>.app; others name the app explicitly.
  const builtApp = t.native?.platform === "ios" && existsSync(join(config.root, "dist", name)) ? readdirSync(join(config.root, "dist", name)).find((f: string): boolean => f.endsWith(".app")) : undefined;
  const appPath = t.app ?? (builtApp ? join("dist", name, builtApp) : undefined);
  if (!appPath || !t.device) throw new CliError("NO_DEVICE", `target "${name}" needs "device" in dotframe.json${appPath ? "" : " and a built app (dotframe build ios)"}`, "xcrun devicectl list devices", "ios");
  const app = resolve(config.root, appPath);
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

// Downloads wgpu-native and builds SDL3 into the vendor dir (default ~/.dotframe/vendor). Local only, slow once.
export async function vendor(ctx: Ctx, platform: string | undefined): Promise<void> {
  if (platform !== "macos" && platform !== "windows" && platform !== "ios") throw new CliError("MISSING_ARG", "vendor needs macos, windows or ios", "dotframe vendor macos", "macos");
  const p = platform as NativePlatform;
  const dir = vendorDir(p);
  const before = vendorStatus(p);
  if (before.missing.length === 0) {
    print(ctx, { platform: p, dir, ready: true }, (): string => `vendor for ${p} is ready in ${dir}`);
    return;
  }
  const command = { label: `vendor ${p}`, argv: ["sh", join(ENGINE, "scripts", "vendor.sh"), p], env: { DOTFRAME_VENDOR: dir } };
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, platform: p, dir, missing: before.missing }, (): string => `would download and build ${before.missing.join(", ")} into ${dir}`);
    return;
  }
  for (const tool of ["curl", "cmake", "unzip", ...(p === "windows" ? ["zig"] : []), ...(p === "ios" ? ["xcodebuild"] : [])]) {
    if (!which(tool)) throw new CliError("TOOL_MISSING", `${tool} not found`, `brew install ${tool}`, "macos");
  }
  await runSteps(ctx, ENGINE, [command], "macos");
  const after = vendorStatus(p);
  if (after.missing.length > 0) throw new CliError("VENDOR_MISSING", `vendor.sh finished but ${after.missing.join(", ")} is still missing`, "", "macos");
  print(ctx, { platform: p, dir, ready: true }, (): string => `vendor for ${p} ready in ${dir}`);
}

interface CrashFile {
  name: string;
  metadata: { lastModDate: string };
}

// The newest crash report of a target's app on the device, summarized: exception, termination, and the crashed
// thread's frames. iOS keeps reports as <Process>-<date>.ips under systemCrashLogs. Read-only on the device.
export async function deviceLogs(ctx: Ctx, name: string): Promise<void> {
  const config = loadConfig();
  const t = target(config, name);
  if (!t.device) throw new CliError("NO_DEVICE", `target "${name}" needs "device" in dotframe.json`, "xcrun devicectl list devices", "ios");
  const builtApp = existsSync(join(config.root, "dist", name)) ? readdirSync(join(config.root, "dist", name)).find((f: string): boolean => f.endsWith(".app")) : undefined;
  const processName = (t.app ? t.app.split("/").pop() : builtApp)?.replace(/\.app$/, "");
  if (!processName) throw new CliError("NOT_BUILT", "no built app to name the process", `dotframe build ${name}`, "ios");
  const logDir = join(config.root, ".dotframe", "logs");
  mkdirSync(logDir, { recursive: true });
  const listing = join(logDir, "device-crashes.json");
  const list = await exec({ ...ctx, json: true }, config.root, { label: "devicectl files", argv: ["xcrun", "devicectl", "device", "info", "files", "--device", t.device, "--domain-type", "systemCrashLogs", "--json-output", listing] });
  if (list.code !== 0) throw new CliError("DEVICE_UNAVAILABLE", list.tail, "connect and unlock the device; xcrun devicectl list devices", "ios");
  const files = (JSON.parse(readFileSync(listing, "utf8")) as { result: { files: CrashFile[] } }).result.files;
  const reports = files
    .filter((f: CrashFile): boolean => f.name.startsWith(`${processName}-`) && f.name.endsWith(".ips"))
    .sort((a: CrashFile, b: CrashFile): number => b.metadata.lastModDate.localeCompare(a.metadata.lastModDate));
  if (reports.length === 0) {
    print(ctx, { process: processName, crashes: 0 }, (): string => `no crash reports for ${processName} on the device`);
    return;
  }
  const newest = reports[0];
  const local = join(logDir, newest.name);
  const copy = await exec({ ...ctx, json: true }, config.root, { label: "devicectl copy", argv: ["xcrun", "devicectl", "device", "copy", "from", "--device", t.device, "--domain-type", "systemCrashLogs", "--source", newest.name, "--destination", local] });
  if (copy.code !== 0) throw new CliError("DEVICE_UNAVAILABLE", copy.tail, "", "ios");
  const [, body] = readFileSync(local, "utf8").split(/\n(.*)/s);
  const report = JSON.parse(body) as {
    exception?: { type?: string; signal?: string };
    termination?: { indicator?: string };
    faultingThread?: number;
    threads?: { frames: { symbol?: string; imageIndex: number }[] }[];
    usedImages?: { name?: string }[];
  };
  const frames = (report.threads?.[report.faultingThread ?? 0]?.frames ?? [])
    .slice(0, 12)
    .map((f) => `${report.usedImages?.[f.imageIndex]?.name ?? "?"}  ${f.symbol ?? "?"}`);
  const summary = {
    process: processName,
    report: local,
    when: newest.metadata.lastModDate,
    crashes: reports.length,
    exception: `${report.exception?.type ?? "?"} ${report.exception?.signal ?? ""}`.trim(),
    termination: report.termination?.indicator ?? null,
    frames,
  };
  print(ctx, summary, (): string =>
    [`${processName} crashed ${newest.metadata.lastModDate} (${reports.length} reports on the device)`, `${summary.exception}${summary.termination ? `, ${summary.termination}` : ""}`, ...frames.map((f) => `  ${f}`), `full report: ${local}`, "a dotframe: ... threw line in the device log names a TypeScript error (build ios wraps init and frame)"].join("\n"),
  );
}
