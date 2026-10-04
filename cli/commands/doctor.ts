import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Config, type Ctx, findRoot, home, loadConfig, print, which } from "../lib";
import { loadSim } from "../simkit";

interface Check {
  check: string;
  ok: boolean;
  detail: string;
  fix: string;
  skill: string;
}

const tool = (bin: string, why: string, fix: string, skill: string): Check => {
  const path = which(bin);
  return { check: `tool:${bin}`, ok: path !== null, detail: path ?? `missing (${why})`, fix: path ? "" : fix, skill };
};

export async function doctor(ctx: Ctx, fix: boolean): Promise<void> {
  const checks: Check[] = [tool("bun", "runs the CLI and the web build", "curl -fsSL https://bun.sh/install | bash", "core")];
  let config: Config | null = null;
  if (!findRoot()) checks.push({ check: "config", ok: false, detail: "no dotframe.json here or above", fix: "cd into a game repo or dotframe new <name>", skill: "core" });
  else {
    try {
      config = loadConfig();
      checks.push({ check: "config", ok: true, detail: `${config.root}/dotframe.json`, fix: "", skill: "core" });
    } catch (error) {
      checks.push({ check: "config", ok: false, detail: error instanceof Error ? error.message : "unreadable", fix: "fix the JSON", skill: "core" });
    }
  }
  if (config) {
    if (config.sim) {
      try {
        const sim = await loadSim(config);
        checks.push({ check: "sim", ok: true, detail: `${config.sim} (${sim.players} players)`, fix: "", skill: "core" });
      } catch (error) {
        checks.push({ check: "sim", ok: false, detail: error instanceof Error ? error.message : "failed to load", fix: "dotframe skills get core (Sim contract)", skill: "core" });
      }
    }
    const targets = Object.keys(config.targets);
    if (targets.some((t: string): boolean => t === "web" || t === "discord")) {
      checks.push(tool("vercel", "deploy web", "npm i -g vercel", "export-web"), tool("agent-browser", "dotframe snap", "npm i -g agent-browser && agent-browser install", "core"));
    }
    if (targets.includes("ios") || targets.includes("macos")) checks.push(tool("scriptc", "native builds", "npm i -g scriptc", "macos"));
    if (targets.includes("ios")) checks.push(tool("xcodegen", "iOS project", "brew install xcodegen", "ios"), tool("xcodebuild", "iOS build", "install Xcode", "ios"));
    if (config.relay) checks.push(config.relay.provider === "fly" ? tool("fly", "relay deploy", "brew install flyctl && fly auth login", "relay") : tool("vps", "relay deploy", "install the vps CLI and log in to the crafter profile", "relay"));
    for (const link of config.links ?? []) {
      const path = resolve(config.root, link.path);
      const want = home(link.target);
      let isLink = false;
      try {
        isLink = lstatSync(path).isSymbolicLink();
      } catch {}
      let ok = existsSync(path) && existsSync(want);
      let detail = ok ? `${link.path} -> ${isLink ? readlinkSync(path) : "(directory)"}` : `${link.path} missing or broken`;
      if (!ok && fix && existsSync(want)) {
        mkdirSync(dirname(path), { recursive: true });
        if (isLink) unlinkSync(path);
        symlinkSync(want, path);
        ok = true;
        detail = `${link.path} -> ${want} (created)`;
      }
      checks.push({ check: `link:${link.path}`, ok, detail, fix: ok ? "" : existsSync(want) ? "dotframe doctor --fix" : `${want} does not exist: run dotframe's scripts/vendor.sh first`, skill: "ios" });
    }
  }
  const failed = checks.filter((c: Check): boolean => !c.ok);
  print(ctx, { ok: failed.length === 0, checks }, (): string =>
    checks.map((c: Check): string => `${c.ok ? "ok  " : "FAIL"} ${c.check}: ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ""}`).join("\n"),
  );
  if (failed.length > 0) process.exit(1);
}
