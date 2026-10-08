import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, print, which } from "../lib";
import type { PlayArgs } from "./play";

// A port's picture next to the original's for the same shot, and how far apart they are: snap renders the port,
// the reference is a PNG (--ref) or what dotframe.json's reference.command writes, and ffmpeg lines them up.
// Metrics are on a 0..1 scale: mean absolute difference, mean luminance of each, and the luminance difference per
// cell of a 3x3 grid (port minus reference, so a negative cell is darker in the port), which says where to look.

const GRID = 3;

function rgb(ffmpeg: string, png: string, width: number, height: number): Uint8Array {
  const r = spawnSync(ffmpeg, ["-v", "error", "-i", png, "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: width * height * 3 + 1024 });
  if (r.status !== 0) throw new CliError("BAD_IMAGE", `ffmpeg could not read ${png}: ${String(r.stderr).trim()}`, "pass a PNG or JPEG", "core");
  return new Uint8Array(r.stdout);
}

export function metrics(a: Uint8Array, b: Uint8Array, width: number, height: number): { mae: number; port: number; reference: number; grid: number[][] } {
  const lum = (p: Uint8Array, i: number): number => (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) / 255;
  let diff = 0;
  let la = 0;
  let lb = 0;
  const cells = Array.from({ length: GRID * GRID }, (): { d: number; n: number } => ({ d: 0, n: 0 }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      diff += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
      const ya = lum(a, i);
      const yb = lum(b, i);
      la += ya;
      lb += yb;
      const c = cells[Math.min(GRID - 1, Math.floor((y * GRID) / height)) * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / width))];
      c.d += ya - yb;
      c.n += 1;
    }
  }
  const n = width * height;
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  const grid = Array.from({ length: GRID }, (_: unknown, row: number): number[] => cells.slice(row * GRID, row * GRID + GRID).map((c): number => r3(c.n ? c.d / c.n : 0)));
  return { mae: r3(diff / n), port: r3(la / n), reference: r3(lb / n), grid };
}

export async function compare(ctx: Ctx, args: PlayArgs & { frame?: string; camera?: string; ref?: string; out?: string }): Promise<void> {
  const config = loadConfig();
  if (args.frame === undefined || args.frame.includes(",")) throw new CliError("MISSING_ARG", "compare needs one --frame <n>", "dotframe compare --frame 600 --ref godot-600.png", "core");
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new CliError("TOOL_MISSING", "ffmpeg not found (compare lines the pictures up with it)", "brew install ffmpeg", "core");
  if (!args.ref && !config.reference) throw new CliError("NO_REFERENCE", "no reference picture: pass --ref <png> or add reference.command to dotframe.json", `"reference": {"command": ["godot", "--path", "../original", "--script", "capture.gd", "--", "shot={shot}", "out={out}"]}`, "core");
  const dir = resolve(process.cwd(), args.out ?? `compare-${args.frame}`);
  mkdirSync(dir, { recursive: true });
  const portPng = join(dir, "port.png");
  const refPng = args.ref ? resolve(process.cwd(), args.ref) : join(dir, "reference.png");
  const shot = { frame: Number(args.frame), seconds: Number(args.frame) / 60, seed: Number(args.seed ?? 1), options: args.options ? JSON.parse(args.options) : {}, camera: args.camera ?? null, inputs: args.inputs ?? null };
  const shotFile = join(dir, "shot.json");
  writeFileSync(shotFile, `${JSON.stringify(shot, null, 2)}\n`);
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, dir, shot, reference: args.ref ?? config.reference?.command.join(" ") }, (): string => `would snap the port to ${portPng}, ${args.ref ? `compare with ${refPng}` : `run ${config.reference?.command.join(" ")}`}, and write ${join(dir, "compare.png")}`);
    return;
  }
  // The port: dotframe snap with the same shot, as a subprocess so its browser session is its own.
  const snapArgs = ["snap", "--frame", args.frame, "--out", portPng, "--json", ...(args.camera ? ["--camera", args.camera] : []), ...(args.inputs ? ["--inputs", args.inputs] : []), ...(args.mash ? ["--mash", args.mash] : []), ...(args.seed ? ["--seed", args.seed] : []), ...(args.options ? ["--options", args.options] : [])];
  const s = await exec({ ...ctx, json: true }, config.root, { label: "snap", argv: [process.execPath, process.argv[1], ...snapArgs], cwd: process.cwd() });
  if (s.code !== 0 || !existsSync(portPng)) throw new CliError("SNAP_FAILED", s.tail.trim().slice(-800), `dotframe ${snapArgs.join(" ")}`, "core");
  if (!args.ref && config.reference) {
    const argv = config.reference.command.map((a: string): string => a.replaceAll("{shot}", shotFile).replaceAll("{out}", refPng));
    const r = await exec({ ...ctx, json: true }, config.root, { label: "reference", argv });
    if (r.code !== 0 || !existsSync(refPng)) throw new CliError("REFERENCE_FAILED", `${argv.join(" ")} did not write ${refPng}: ${r.tail.trim().slice(-800)}`, "run the reference command by hand with that shot.json", "core");
  }
  if (!existsSync(refPng)) throw new CliError("NOT_FOUND", `no reference at ${refPng}`, "pass --ref <png>", "core");
  // The port's size sets the grid; the reference is scaled to it (same aspect expected).
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", portPng], { encoding: "utf8" });
  const [width, height] = probe.stdout.trim().split(",").map(Number);
  if (!width || !height) throw new CliError("BAD_IMAGE", `cannot read the size of ${portPng}`, "", "core");
  const m = metrics(rgb(ffmpeg, portPng, width, height), rgb(ffmpeg, refPng, width, height), width, height);
  // port | reference | difference (amplified 4x so small shifts show).
  const composite = join(dir, "compare.png");
  const f = spawnSync(ffmpeg, ["-v", "error", "-y", "-i", portPng, "-i", refPng, "-filter_complex", `[1:v]scale=${width}:${height}[r];[0:v]split[p0][p1];[r]split[r0][r1];[p1][r1]blend=all_mode=difference,lutrgb=r='val*4':g='val*4':b='val*4'[d];[p0][r0][d]hstack=3`, composite]);
  if (f.status !== 0) throw new CliError("COMPOSE_FAILED", String(f.stderr).trim(), "", "core");
  // The metrics carry their own port and reference (mean luminance), so the image paths go under images.
  const result = { dir, images: { port: portPng, reference: refPng, compare: composite }, ...m };
  print(ctx, result, (): string =>
    [
      `${composite}  (port | reference | difference x4)`,
      `mean difference ${m.mae}  luminance port ${m.port} reference ${m.reference}`,
      "luminance port - reference, 3x3 (negative: the port is darker there):",
      ...m.grid.map((row: number[]): string => `  ${row.map((v: number): string => (v >= 0 ? ` ${v.toFixed(3)}` : v.toFixed(3))).join("  ")}`),
    ].join("\n"),
  );
}
