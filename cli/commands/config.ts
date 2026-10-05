import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, CliError, type Ctx, formatJson, home, loadConfig, loadUserConfig, print, saveUserConfig, USER_KEYS, userConfigPath } from "../lib";

// Dotted keys: targets.web.deploy.project
export async function configCmd(ctx: Ctx, args: string[]): Promise<void> {
  const [op, key, value] = args;
  // Machine paths go to ~/.dotframe/config.json, never into the repo.
  if (key && (USER_KEYS as readonly string[]).includes(key)) {
    const user = loadUserConfig();
    if (op === "get") {
      print(ctx, { key, value: user.vendor ?? null, file: userConfigPath() }, (): string => user.vendor ?? "(not set)");
      return;
    }
    if (op !== "set" || value === undefined) throw new CliError("MISSING_ARG", `config set ${key} needs a value`, `dotframe config set ${key} ~/Programming/crafter-games/dotframe/vendor`);
    const dir = resolve(home(value));
    if (!existsSync(dir)) throw new CliError("BAD_ARG", `${dir} does not exist`, "point at a vendor dir that holds wgpu/ and SDL3-*/");
    if (ctx.dryRun) {
      print(ctx, { dryRun: true, key, value: dir, file: userConfigPath() }, (): string => `would set ${key} = ${dir} in ${userConfigPath()}`);
      return;
    }
    saveUserConfig({ ...user, vendor: dir });
    print(ctx, { key, value: dir, file: userConfigPath() }, (): string => `${key} = ${dir} (${userConfigPath()})`);
    return;
  }
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
