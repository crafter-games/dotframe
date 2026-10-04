import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix = "",
    readonly skill = "core",
    readonly exit = 1,
  ) {
    super(message);
  }
}

export interface Ctx {
  json: boolean;
  yes: boolean;
  dryRun: boolean;
}

export function print(ctx: Ctx, data: unknown, human: () => string): void {
  if (ctx.json) console.log(JSON.stringify({ ok: true, data }));
  else console.log(human());
}

export function fail(ctx: Ctx, error: unknown): never {
  const e = error instanceof CliError ? error : new CliError("INTERNAL", error instanceof Error ? error.message : String(error));
  if (ctx.json) console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, fix: e.fix, skill: e.skill } }));
  else {
    console.error(`error ${e.code}: ${e.message}`);
    if (e.fix) console.error(`fix: ${e.fix}`);
    console.error(`guide: dotframe skills get ${e.skill}`);
  }
  process.exit(e.exit);
}

// External writes (deploys, installs, publishes) need --yes. --dry-run always wins.
export function gate(ctx: Ctx, action: string, skill: string): void {
  if (!ctx.yes) throw new CliError("APPROVAL_REQUIRED", `${action} changes something outside this machine`, "review with --dry-run, then rerun with --yes", skill, 2);
}

export interface Command {
  label: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Target {
  steps: Command[];
  out?: string;
  app?: string;
  device?: string;
  deploy?: { provider: "vercel"; project: string; scope: string };
}

export interface Config {
  root: string;
  name: string;
  sim?: string;
  targets: Record<string, Target>;
  relay?: { provider: "dokploy"; compose: string } | { provider: "fly"; app: string; config: string; region?: string };
  links?: { path: string; target: string }[];
  assets?: { localOnly?: string[] };
}

export const CONFIG_FILE = "dotframe.json";

export function findRoot(from = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function home(path: string): string {
  return path.startsWith("~/") ? join(process.env.HOME ?? "", path.slice(2)) : path;
}

export function loadConfig(): Config {
  const root = findRoot();
  if (!root) throw new CliError("NO_CONFIG", `no ${CONFIG_FILE} in this directory or any parent`, "cd into a game repo, or run dotframe new <name>");
  try {
    return { ...(JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8")) as Omit<Config, "root">), root };
  } catch (error) {
    throw new CliError("BAD_CONFIG", `${CONFIG_FILE}: ${error instanceof Error ? error.message : "unreadable"}`, "fix the JSON syntax");
  }
}

export function target(config: Config, name: string): Target {
  const t = config.targets[name];
  if (!t) throw new CliError("UNKNOWN_TARGET", `target "${name}" is not in ${CONFIG_FILE}`, `known targets: ${Object.keys(config.targets).join(", ") || "none"}`, "core");
  return t;
}

export function which(bin: string): string | null {
  return Bun.which(bin);
}

export interface RunResult {
  label: string;
  code: number;
  ms: number;
  tail: string;
}

// Runs a command to completion. Output streams to stderr in human mode and is captured (tail kept) in JSON mode.
export async function exec(ctx: Ctx, root: string, command: Command): Promise<RunResult> {
  const t0 = performance.now();
  const proc = Bun.spawn(command.argv, {
    cwd: command.cwd ? resolve(root, command.cwd) : root,
    env: { ...process.env, ...command.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const chunks: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      chunks.push(text);
      if (!ctx.json) process.stderr.write(text);
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  const tail = chunks.join("").split("\n").slice(-20).join("\n").trim();
  return { label: command.label, code, ms: Math.round(performance.now() - t0), tail };
}

export async function runSteps(ctx: Ctx, root: string, steps: Command[], skill: string): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const step of steps) {
    if (ctx.dryRun) {
      results.push({ label: step.label, code: 0, ms: 0, tail: `would run: ${step.argv.join(" ")} (cwd ${step.cwd ?? "."})` });
      continue;
    }
    if (!ctx.json) console.error(`> ${step.label}`);
    const r = await exec(ctx, root, step);
    results.push(r);
    if (r.code !== 0) throw new CliError("STEP_FAILED", `step "${step.label}" exited ${r.code}\n${r.tail}`, "read the output above; dotframe doctor checks the toolchain", skill);
  }
  return results;
}

// Numeric flags: a bad value is an error, never a silent NaN that runs zero frames.
export function num(flag: string, raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value) || value < min) {
    throw new CliError("BAD_ARG", `--${flag} must be an integer >= ${min}, got "${raw}"`, `--${flag} ${Math.max(min, fallback)}`);
  }
  return value;
}

// Durations in milliseconds ("120ms" or "120"), converted to 60 Hz frames.
export function frames60(flag: string, raw: string | undefined, fallbackMs: number): number {
  const text = raw ?? `${fallbackMs}ms`;
  const match = text.trim().match(/^(\d+(?:\.\d+)?)(ms)?$/);
  if (!match) throw new CliError("BAD_ARG", `--${flag} must be a duration like 120ms, got "${text}"`, `--${flag} ${fallbackMs}ms`);
  return Math.round(Number(match[1]) / (1000 / 60));
}

// JSON with short objects and arrays kept on one line, so `config set` does not explode a hand-written file.
export function formatJson(value: unknown, indent = "", width = 100): string {
  const inline = JSON.stringify(value, null, 1).replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]").replace(/\{ /g, "{ ").replace(/ \}/g, " }");
  if (value === null || typeof value !== "object" || indent.length + inline.length <= width) return inline;
  const next = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => next + formatJson(v, next, width)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${formatJson(v, next, width)}`).join(",\n")}\n${indent}}`;
}
