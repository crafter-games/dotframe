import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { type Config, type Ctx, findRoot, home, loadConfig, print, which } from "../lib";
import type { Draw2D } from "../../src/draw2d";
import type { Sim } from "../../src/sim";
import { importGraph, vendorFix, vendorStatus } from "../native";
import { iosPackFix, iosRuntimePack } from "../ios";
import { dockerCheck } from "./docker";
import { firstDifference, flatten, headlessRun, loadSim } from "../simkit";

interface Check {
  check: string;
  ok: boolean;
  // A finding worth reading that does not fail doctor.
  warn?: boolean;
  detail: string;
  fix: string;
  skill: string;
}

const tool = (bin: string, why: string, fix: string, skill: string): Check => {
  const path = which(bin);
  return { check: `tool:${bin}`, ok: path !== null, detail: path ?? `missing (${why})`, fix: path ? "" : fix, skill };
};

export async function doctor(ctx: Ctx, fix: boolean, docker = false): Promise<void> {
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
        checks.push(await renderCheck(sim, config.root));
        checks.push(mathCheck(resolve(config.root, config.sim as string)));
      } catch (error) {
        checks.push({ check: "sim", ok: false, detail: error instanceof Error ? error.message : "failed to load", fix: "dotframe skills get core (Sim contract)", skill: "core" });
      }
    }
    for (const [name, t] of Object.entries(config.targets)) {
      if (t.native?.platform === "ios" && t.native.team === "YOUR_TEAM_ID") {
        checks.push({ check: `ios:${name}`, ok: false, detail: "the iOS team is still the template placeholder", fix: `dotframe config set targets.${name}.native.team '"<Apple team id>"'`, skill: "ios" });
      }
      if (t.deploy?.provider === "vercel" && t.deploy.scope === "your-vercel-team") {
        checks.push({ check: `deploy:${name}`, ok: false, detail: "deploy scope is still the template placeholder", fix: `dotframe config set targets.${name}.deploy.scope '"<vercel team>"'`, skill: "export-web" });
      }
    }
    for (const [name, t] of Object.entries(config.targets)) {
      if (!t.native) continue;
      const v = vendorStatus(t.native.platform);
      checks.push({ check: `vendor:${name}`, ok: v.missing.length === 0, detail: v.missing.length === 0 ? `${v.dir} (${v.sdl})` : `missing in ${v.dir}: ${v.missing.join(", ")}`, fix: v.missing.length === 0 ? "" : vendorFix(t.native.platform), skill: t.native.platform });
      checks.push(tool("scriptc", "native builds", "npm i -g scriptc", t.native.platform));
      if (t.native.platform === "windows") checks.push(tool("zig", "windows cross builds", "brew install zig", "macos"));
      if (t.native.platform === "ios") {
        checks.push(tool("xcodegen", "iOS project", "brew install xcodegen", "ios"));
        const pack = await iosRuntimePack(ctx, config.root);
        checks.push({ check: `ios-runtime:${name}`, ok: pack.path !== null, detail: pack.path ? `@scriptc/runtime-ios-arm64 ${pack.want}` : pack.found ? `runtime pack ${pack.found} does not match scriptc ${pack.want}` : `@scriptc/runtime-ios-arm64 ${pack.want} not installed`, fix: pack.path ? "" : iosPackFix(pack.want), skill: "ios" });
      }
    }
    for (const bin of config.requires ?? []) checks.push(tool(bin, "listed in requires", `brew install ${bin}`, "export-web"));
    if (docker) {
      const dockerized = Object.values(config.targets).some((t) => t.deploy?.provider === "dokploy");
      checks.push(dockerized ? await dockerCheck(ctx, config) : { check: "docker:web", ok: false, detail: "no target deploys with provider dokploy", fix: "dotframe deploy init web --provider dokploy", skill: "export-web" });
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
  const failed = checks.filter((c: Check): boolean => !c.ok && !c.warn);
  print(ctx, { ok: failed.length === 0, checks }, (): string =>
    checks.map((c: Check): string => `${c.ok ? "ok  " : c.warn ? "WARN" : "FAIL"} ${c.check}: ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ""}`).join("\n"),
  );
  if (failed.length > 0) process.exit(1);
}

// desync proves rendering is pure by calling render() with a stub Draw2D. Two failure modes are checked here,
// instantly: a render that draws nothing with the stub (desync's check would be blind), and a render that
// changes simulation state (checksum or, with inspect(), any field).
async function renderCheck(sim: Sim, root: string): Promise<Check> {
  const base = { check: "sim:render", skill: "netplay" };
  const run = await headlessRun(sim, root);
  if (!run.render) return { ...base, ok: false, detail: "the sim has no render(); desync cannot check render purity", fix: "add render: (draw) => ... to the SimRun", skill: "core" };
  let calls = 0;
  const draw = new Proxy({} as Draw2D, {
    get: (_t: Draw2D, key: string | symbol): unknown => {
      if (key === "measureText") return (): { width: number } => ({ width: 10 });
      if (key === "getGlobalAlpha") return (): number => 1;
      return (): void => {
        calls += 1;
      };
    },
  });
  run.start(1, { ...sim.options });
  let next = 1;
  const random = (): number => {
    next = (Math.imul(next, 1103515245) + 12345) >>> 0;
    return next / 4294967296;
  };
  // Mashed inputs, so effects, projectiles, and HUD state exist when render runs.
  let impure = "";
  for (let f = 0; f < 3000 && impure === "" && !run.over(); f++) {
    run.step(Array.from({ length: sim.players }, (): number => sim.random(random)));
    if (f % 10 !== 0) continue;
    const sum = run.checksum();
    const before = run.inspect ? flatten(run.inspect()) : null;
    run.render(draw);
    if (run.checksum() !== sum) impure = `frame ${f}: checksum changed`;
    else if (before && run.inspect) {
      const diff = firstDifference(before, flatten(run.inspect()));
      if (diff) impure = `frame ${f}: ${diff}`;
    }
  }
  if (calls === 0) return { ...base, ok: false, detail: "render() made no draw calls with a stub Draw2D, so desync never exercises it", fix: "render with whatever Draw2D it is given; do not skip when platform.draw is missing" };
  if (impure) return { ...base, ok: false, detail: `render() changed simulation state at ${impure}`, fix: "move that write into step(); render must only read", skill: "netplay" };
  return { ...base, ok: true, detail: `render() drew ${calls} calls with a stub Draw2D and left state unchanged${run.inspect ? "" : " (checksum only; add inspect() for every field)"}`, fix: "" };
}

// Math.sin and friends differ in the last bits between engines and OSes, so simulation code that calls them drifts
// between netplay peers and breaks replays on another machine. Render code may use them; mark a line with
// `dotframe-allow-math` to silence it.
const NONDETERMINISTIC = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b|[\w)\]]\s*\*\*\s*[\w(]/;

function mathCheck(simFile: string): Check {
  const base = { check: "sim:math", skill: "netplay" };
  const hits: string[] = [];
  for (const file of importGraph(simFile).files) {
    if (!/\.tsx?$/.test(file) || file.includes(`${sep}node_modules${sep}`)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line: string, i: number): void => {
        const code = line.replace(/\/\/.*$/, "");
        if (NONDETERMINISTIC.test(code) && !line.includes("dotframe-allow-math")) hits.push(`${relative(process.cwd(), file)}:${i + 1}`);
      });
  }
  if (hits.length === 0) return { ...base, ok: true, detail: "no Math.sin/cos/exp/pow or ** in code the sim reaches", fix: "" };
  const shown = hits.slice(0, 8).join(", ") + (hits.length > 8 ? `, and ${hits.length - 8} more` : "");
  return {
    ...base,
    ok: false,
    warn: true,
    detail: `${hits.length} platform-dependent math call(s) in code the sim reaches: ${shown}`,
    fix: "use dotframe/src/detmath (dsin, dcos, datan2, dexp, dpow, ...) in simulation code; mark render-only lines with // dotframe-allow-math",
  };
}
