import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CliError, type Ctx, exec, home, print, type RunResult, which } from "./lib";

// The engine this CLI belongs to: a git checkout or node_modules/dotframe.
export const ENGINE = resolve(import.meta.dir, "..");

export type NativePlatform = "macos" | "windows" | "ios";

export interface NativeTarget {
  platform: "macos" | "windows";
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
  const need = [`wgpu/${platform}/lib/libwgpu_native.a`, sdlLibrary(platform)];
  const missing = need.filter((p: string): boolean => !existsSync(join(dir, p)));
  if (!sdl) missing.push("SDL3-<version> (headers)");
  return { dir, missing, sdl };
}

// Relative to the vendor dir; iOS builds with the Xcode generator.
export function sdlLibrary(platform: NativePlatform): string {
  return platform === "ios" ? "build/sdl-ios/Release-iphoneos/libSDL3.a" : `build/sdl-${platform}/libSDL3.a`;
}

export function vendorFix(platform: NativePlatform): string {
  return `dotframe vendor ${platform} (builds into ~/.dotframe/vendor), or point DOTFRAME_VENDOR at an existing vendor dir such as a dotframe checkout's vendor/`;
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)(["'])([^"']+)\1/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".json", "/index.ts", "/index.tsx"];

function resolveFile(base: string): string | null {
  const candidates = [base.replace(/\.js$/, ".ts"), base];
  for (const c of candidates) for (const ext of EXTENSIONS) if (existsSync(c + ext) && statSync(c + ext).isFile()) return realpathSync(c + ext);
  return null;
}

// A bare specifier that resolves, through node_modules, to TypeScript source outside node_modules: a workspace
// package (bun and npm link those). Published packages stay packages.
function resolveWorkspace(specifier: string, fromDir: string): string | null {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const sub = parts.slice(name.split("/").length).join("/");
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", name);
    if (existsSync(pkgDir)) {
      const real = realpathSync(pkgDir);
      if (real.split(sep).includes("node_modules")) return null;
      if (sub) return resolveFile(join(real, sub));
      const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as Record<string, unknown>;
      const exp = pkg.exports as Record<string, unknown> | string | undefined;
      const dot = typeof exp === "string" ? exp : (exp?.["."] as Record<string, string> | string | undefined);
      const entry = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? dot?.types ?? (pkg.module as string) ?? (pkg.main as string) ?? "index.ts");
      return resolveFile(join(real, entry));
    }
    if (dirname(dir) === dir) return null;
  }
}

interface Graph {
  files: string[];
  // Per file, the specifiers to rewrite and the absolute file each one points at.
  links: Map<string, Map<string, string>>;
}

// Every source file the entry reaches: relative imports (including ones that leave the game root) and workspace
// packages. "dotframe/..." is the engine, staged separately.
export function importGraph(entry: string): Graph {
  const files: string[] = [];
  const links = new Map<string, Map<string, string>>();
  const queue = [realpathSync(entry)];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    files.push(file);
    if (!/\.tsx?$/.test(file)) continue;
    const map = new Map<string, string>();
    for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = m[2];
      if (spec.startsWith("dotframe/") || spec.startsWith("node:")) continue;
      const target = spec.startsWith(".") ? resolveFile(resolve(dirname(file), spec)) : resolveWorkspace(spec, dirname(file));
      if (!target) continue;
      if (!spec.startsWith(".")) map.set(spec, target);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
    links.set(file, map);
  }
  return { files, links };
}

function commonDir(paths: string[]): string {
  let base = dirname(paths[0]);
  for (const p of paths) while (!(p + sep).startsWith(base === sep ? sep : base + sep)) base = dirname(base);
  return base;
}

function rel(fromFile: string, to: string): string {
  const r = relative(dirname(fromFile), to);
  return r.startsWith(".") ? r : `./${r}`;
}

// scriptc's static build takes relative imports only, and treats anything under node_modules as package code for
// its dynamic engine. Staging copies the engine and every reached game file side by side, keeping their relative
// layout, and rewrites "dotframe/..." and workspace imports to relative paths.
export function stageGame(root: string, entry: string, tree: string, engineStage: string): string {
  const graph = importGraph(join(root, entry));
  const base = commonDir([realpathSync(root) + sep + "x", ...graph.files]);
  const staged = (file: string): string => join(tree, relative(base, file));
  for (const file of graph.files) {
    const to = staged(file);
    mkdirSync(dirname(to), { recursive: true });
    let text = readFileSync(file, "utf8");
    if (/\.tsx?$/.test(file)) {
      const map = graph.links.get(file) ?? new Map<string, string>();
      text = text.replace(SPECIFIER, (whole: string, q: string, spec: string): string => {
        if (spec.startsWith("dotframe/")) return whole.replace(`${q}${spec}${q}`, `${q}${rel(to, join(engineStage, spec.slice("dotframe/".length)))}${q}`);
        const target = map.get(spec);
        return target ? whole.replace(`${q}${spec}${q}`, `${q}${rel(to, staged(target)).replace(/\.tsx?$/, "")}${q}`) : whole;
      });
    }
    writeFileSync(to, text);
  }
  return join(tree, relative(base, realpathSync(root)));
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
  if (!existsSync(join(root, t.entry))) throw new CliError("ENTRY_MISSING", `native entry ${t.entry} does not exist`, `add ${t.entry} (see the macos skill) or fix targets.${targetName}.native.entry`, skill);
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, platform, stage, vendor: vendor.dir, binary }, (): string => `would stage the engine and game in ${stage} and build ${binary}`);
    return { binary, log, steps: [] };
  }
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(out, { recursive: true });
  const engineStage = join(stage, "dotframe");
  cpSync(join(ENGINE, "src"), join(engineStage, "src"), { recursive: true });
  const gameStage = stageGame(root, t.entry, join(stage, "game"), engineStage);

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
