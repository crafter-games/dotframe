import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, type Ctx, print, which } from "../lib";
import { ENGINE } from "../native";
import { slimAssets } from "../slim";

export function assetsSlim(ctx: Ctx, src: string | undefined, out: string | undefined, jpeg: boolean, clips?: string[], rename?: Record<string, string>, decimate?: Record<string, number>): void {
  if (!src || !out) throw new CliError("USAGE", "assets slim needs a source and an output (two folders, or two .glb files)", "dotframe assets slim assets dist/web/assets", "core");
  if (!existsSync(src)) throw new CliError("NOT_FOUND", `nothing at ${src}`, "pass the game's assets folder, or one .glb", "core");
  if (resolve(src) === resolve(out)) throw new CliError("USAGE", "the output must differ from the source", "write to the build output, for example dist/web/assets", "core");
  const report = slimAssets(src, out, { jpeg, clips, rename, decimate });
  const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
  print(ctx, report, () =>
    [
      ...report.files.map((f) => `${f.path}  ${mb(f.before)} -> ${mb(f.after)}${f.note ? `  (${f.note})` : ""}`),
      `${src} ${mb(report.before)} -> ${out} ${mb(report.after)}${report.jpeg ? "" : "  (no ffmpeg or --no-jpeg: PNG textures kept)"}`,
    ].join("\n"),
  );
}

// Characters a game draws beyond ASCII and Latin-1 (kanji, kana, dashes, quotes), from its source and data files,
// so a baked font cannot miss a glyph a caption uses.
function charsIn(dir: string): string {
  const chars = new Set<string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|json|txt|md|csv)$/.test(name)) for (const c of readFileSync(p, "utf8")) if ((c.codePointAt(0) ?? 0) > 0xff) chars.add(c);
    }
  };
  walk(dir);
  return [...chars].sort().join("");
}

// tools/bake-font.c, built once per machine into ~/.dotframe/tools (again when the source is newer).
function bakeFontTool(): string {
  const source = join(ENGINE, "tools", "bake-font.c");
  if (!existsSync(source)) throw new CliError("TOOL_MISSING", `${source} is missing from this dotframe install`, "update dotframe (0.2.1 and later ship tools/bake-font.c)", "assets");
  const dir = join(homedir(), ".dotframe", "tools");
  const bin = join(dir, process.platform === "win32" ? "bake-font.exe" : "bake-font");
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(source).mtimeMs) return bin;
  const cc = ["cc", "clang", "gcc"].find((c: string): boolean => which(c) !== null);
  if (!cc) throw new CliError("TOOL_MISSING", "no C compiler (cc, clang or gcc) to build bake-font", process.platform === "darwin" ? "xcode-select --install" : "install clang or gcc", "assets");
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(cc, ["-O2", source, "-o", bin, "-lm"], { encoding: "utf8" });
  if (r.status !== 0) throw new CliError("BUILD_FAILED", `bake-font did not compile: ${r.stderr.trim()}`, `${cc} -O2 ${source} -o ${bin} -lm`, "assets");
  return bin;
}

// Bakes a TTF into the SDF atlas (out.png) and metrics (out.json) Draw2D.addFont reads.
export function assetsFont(ctx: Ctx, ttf: string | undefined, out: string | undefined, size: string | undefined, charsFrom: string | undefined): void {
  if (!ttf || !out) throw new CliError("USAGE", "assets font needs a .ttf and an output path without extension", "dotframe assets font tools/KleeOne.ttf assets/fonts/klee-one --chars-from src", "assets");
  if (!existsSync(ttf)) throw new CliError("NOT_FOUND", `no font at ${ttf}`, "pass a .ttf or .otf file", "assets");
  const px = size ?? "48";
  if (!/^\d+$/.test(px)) throw new CliError("BAD_ARG", `--size ${px} is not a pixel height`, "--size 48", "assets");
  if (charsFrom && !existsSync(charsFrom)) throw new CliError("NOT_FOUND", `no folder at ${charsFrom}`, "--chars-from src", "assets");
  const extra = charsFrom ? charsIn(charsFrom) : "";
  const plan = { font: ttf, png: `${out}.png`, json: `${out}.json`, size: Number(px), extra: [...extra].length };
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, ...plan, chars: extra }, (): string => `would bake ${ttf} at ${px} px to ${out}.png and ${out}.json, ASCII and Latin-1 plus ${plan.extra} characters`);
    return;
  }
  const bin = bakeFontTool();
  const args = [ttf, `${out}.png`, `${out}.json`, px];
  if (extra) {
    const list = join(tmpdir(), `dotframe-font-chars-${process.pid}.txt`);
    writeFileSync(list, extra);
    args.push(list);
  }
  mkdirSync(resolve(out, ".."), { recursive: true });
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new CliError("BAKE_FAILED", (r.stderr || r.stdout).trim(), "check that the file is a TrueType or OpenType font", "assets");
  print(ctx, { ...plan, output: r.stdout.trim() }, (): string => `${r.stdout.trim()}${plan.extra ? ` (${plan.extra} characters beyond Latin-1 from ${charsFrom})` : ""}\nkeep the font's license next to the atlas`);
}
