import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CliError, type Ctx, exec, home, print, type RunResult, which } from "./lib";

// The engine this CLI belongs to: a git checkout or node_modules/dotframe.
export const ENGINE = resolve(import.meta.dir, "..");

export type NativePlatform = "macos" | "windows";

export interface NativeTarget {
  platform: NativePlatform;
  // Entry module, relative to the game root.
  entry: string;
  // Binary name; defaults to the game name.
  name?: string;
}

// Vendored SDL3 and wgpu-native: DOTFRAME_VENDOR, else a checkout's own vendor/ when it is populated, else a
// per-user cache that survives reinstalling the package.
export function vendorDir(platform: NativePlatform): string {
  if (process.env.DOTFRAME_VENDOR) return resolve(home(process.env.DOTFRAME_VENDOR));
  const local = join(ENGINE, "vendor");
  if (existsSync(join(local, "wgpu", platform))) return local;
  return join(homedir(), ".dotframe", "vendor");
}

export interface VendorStatus {
  dir: string;
  missing: string[];
  sdl: string | null;
}

export function vendorStatus(platform: NativePlatform): VendorStatus {
  const dir = vendorDir(platform);
  const sdl = existsSync(dir) ? (readdirSync(dir).find((d: string): boolean => d.startsWith("SDL3-")) ?? null) : null;
  const need = [`wgpu/${platform}/lib/libwgpu_native.a`, `build/sdl-${platform}/libSDL3.a`];
  const missing = need.filter((p: string): boolean => !existsSync(join(dir, p)));
  if (!sdl) missing.push("SDL3-<version> (headers)");
  return { dir, missing, sdl };
}

export function vendorFix(platform: NativePlatform): string {
  return `dotframe vendor ${platform}`;
}

const SKIP = new Set(["node_modules", ".git", ".dotframe", "dist", "build", ".vercel"]);

function copyTs(from: string, to: string): number {
  let n = 0;
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const src = join(from, name);
    if (statSync(src).isDirectory()) n += copyTs(src, join(to, name));
    else if (name.endsWith(".ts") || name.endsWith(".json")) {
      mkdirSync(to, { recursive: true });
      cpSync(src, join(to, name));
      n += 1;
    }
  }
  return n;
}

// scriptc's static build takes relative imports only, and treats anything under node_modules as package code
// for its dynamic engine. Staging copies the engine and the game side by side and rewrites "dotframe/..."
// imports to relative paths.
function rewriteImports(dir: string, engineRoot: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      rewriteImports(path, engineRoot);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(path, "utf8");
    const next = text.replace(/(from\s+|import\s*\(\s*)(["'])dotframe\/([^"']+)\2/g, (_m: string, head: string, q: string, rest: string): string => {
      let rel = relative(dirname(path), join(engineRoot, rest));
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${head}${q}${rel}${q}`;
    });
    if (next !== text) writeFileSync(path, next);
  }
}

export async function buildNative(ctx: Ctx, root: string, gameName: string, targetName: string, t: NativeTarget): Promise<{ binary: string; log: string; steps: RunResult[] }> {
  const platform = t.platform;
  const skill = platform;
  const tools = platform === "macos" ? ["clang", "scriptc"] : ["zig", "scriptc"];
  for (const tool of tools) if (!which(tool)) throw new CliError("TOOL_MISSING", `${tool} not found`, tool === "scriptc" ? "npm i -g scriptc" : tool === "zig" ? "brew install zig" : "xcode-select --install", skill);
  const vendor = vendorStatus(platform);
  if (vendor.missing.length > 0) throw new CliError("VENDOR_MISSING", `native ${platform} needs SDL3 and wgpu-native in ${vendor.dir}; missing ${vendor.missing.join(", ")}`, vendorFix(platform), skill);

  const stage = join(root, ".dotframe", "native", targetName);
  const logDir = join(root, ".dotframe", "logs");
  const log = join(logDir, `build-${targetName}.log`);
  const out = join(root, "dist", targetName);
  const binary = join(out, `${t.name ?? gameName}${platform === "windows" ? ".exe" : ""}`);
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, platform, stage, vendor: vendor.dir, binary }, (): string => `would stage the engine and game in ${stage} and build ${binary}`);
    return { binary, log, steps: [] };
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(out, { recursive: true });
  const engineStage = join(stage, "dotframe");
  cpSync(join(ENGINE, "src"), join(engineStage, "src"), { recursive: true });
  const gameStage = join(stage, "game");
  copyTs(root, gameStage);
  rewriteImports(gameStage, engineStage);

  const inc = [`-I${join(vendor.dir, vendor.sdl ?? "", "include")}`, `-I${join(vendor.dir, "wgpu", platform, "include")}`];
  const lib = join(stage, "lib");
  mkdirSync(lib, { recursive: true });
  const cc = platform === "macos" ? ["clang", "-O2", "-mmacosx-version-min=14.0"] : ["zig", "cc", "-target", "x86_64-windows-gnu", "-O2"];
  const ar = platform === "macos" ? ["ar", "rcs"] : ["zig", "ar", "rcs"];
  const steps = [
    ...["df_native", "df_audio"].map((unit) => ({ label: `cc ${unit}`, argv: [...cc, "-c", join(ENGINE, "native", `${unit}.c`), ...inc, "-o", join(lib, `${unit}.o`)] })),
    { label: "ar libdf_native", argv: [...ar, join(lib, "libdf_native.a"), join(lib, "df_native.o"), join(lib, "df_audio.o")] },
  ];
  const ffi = JSON.parse(readFileSync(join(ENGINE, "native", `ffi.${platform}.json`), "utf8")) as { libraries: string[] };
  ffi.libraries = [join(lib, "libdf_native.a"), join(vendor.dir, "build", `sdl-${platform}`, "libSDL3.a"), join(vendor.dir, "wgpu", platform, "lib", "libwgpu_native.a")];
  writeFileSync(join(stage, "ffi.json"), JSON.stringify(ffi, null, 2));
  const entry = join(gameStage, t.entry);
  if (!existsSync(entry)) throw new CliError("ENTRY_MISSING", `native entry ${t.entry} does not exist`, `add ${t.entry} (see the macos skill) or fix targets.${targetName}.native.entry`, skill);
  let env: Record<string, string> = {};
  if (platform === "windows") {
    // A devDependency of dotframe, so an npm install of dotframe does not bring it; the game can.
    const pack = [ENGINE, root].map((dir: string): string => join(dir, "node_modules", "@scriptc", "runtime-win32-x64-msvc")).find((p: string): boolean => existsSync(p));
    if (!pack) throw new CliError("TOOL_MISSING", "the scriptc Windows runtime pack is not installed", "bun add -d @scriptc/runtime-win32-x64-msvc", skill);
    env = { SCRIPTC_TARGET: "x86_64-windows-gnu", SCRIPTC_RUNTIME_PACK: pack };
  }
  const scriptc = {
    label: "scriptc",
    argv: ["scriptc", "build", t.entry, "--ffi", join(stage, "ffi.json"), ...(platform === "windows" ? ["--windows-subsystem", "gui"] : []), "-o", binary],
    cwd: gameStage,
    env,
  };
  const results: RunResult[] = [];
  const full: string[] = [];
  for (const step of [...steps, scriptc]) {
    if (!ctx.json) console.error(`> ${step.label}`);
    const r = await exec(ctx, root, step);
    full.push(`> ${step.label}: ${step.argv.join(" ")}\n${r.output}`);
    writeFileSync(log, full.join("\n"));
    results.push(r);
    if (r.code !== 0) {
      const count = r.output.match(/(\d+) errors?/)?.[1];
      throw new CliError("STEP_FAILED", `step "${step.label}" exited ${r.code}${count ? ` with ${count} errors` : ""}; full output in ${log}\n${r.tail}`, `read ${log}`, skill, 1, log);
    }
  }
  return { binary, log, steps: results };
}
