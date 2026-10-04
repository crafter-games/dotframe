import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, CliError, type Ctx, formatJson, loadConfig, print } from "../lib";

// Dotted keys: targets.web.deploy.project
export async function configCmd(ctx: Ctx, args: string[]): Promise<void> {
  const [op, key, value] = args;
  const config = loadConfig();
  const file = join(config.root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const parts = key ? key.split(".") : [];
  if (op === "get" || op === undefined) {
    let cur: unknown = raw;
    for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
    if (cur === undefined) throw new CliError("UNKNOWN_KEY", `${key} is not set`, "dotframe config get");
    print(ctx, { key: key ?? null, value: cur }, (): string => (typeof cur === "string" ? cur : JSON.stringify(cur, null, 2)));
    return;
  }
  if (op !== "set" || !key || value === undefined) throw new CliError("MISSING_ARG", "config set needs <key> <json value>", `dotframe config set targets.ios.device '"00008120-..."'`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  let cur = raw;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = parsed;
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, key, value: parsed }, (): string => `would set ${key} = ${JSON.stringify(parsed)}`);
    return;
  }
  writeFileSync(file, `${formatJson(raw)}\n`);
  print(ctx, { key, value: parsed }, (): string => `${key} = ${JSON.stringify(parsed)}`);
}
