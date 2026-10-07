import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Sim, SimRun } from "../src/sim";
import type { RenderGpu, Texture } from "../src/gpu";
import { CliError, type Config, num } from "./lib";

let nextTexture = 1;
// Texture ids restart per run so two runs of the same game have identical state graphs.
export function resetStubGpu(): void {
  nextTexture = 1;
}
export const stubGpu: RenderGpu = {
  createBuffer: (): number => 0,
  writeBuffer: (): void => {},
  destroyBuffer: (): void => {},
  createPipeline: (): number => 0,
  bind: (): number => 0,
  createTexture: (width: number, height: number): Texture => ({ id: nextTexture++, width, height }) as Texture,
  createTarget: (width: number, height: number): Texture => ({ id: nextTexture++, width, height }) as Texture,
  destroyTexture: (): void => {},
  frame: (): void => {},
  aspect: (): number => 16 / 9,
} as RenderGpu;

export function simPath(config: Config): string {
  if (!config.sim) throw new CliError("NO_SIM", `dotframe.json has no "sim" module`, `add "sim": "path/to/sim.ts" exporting defineSim(...)`, "core");
  const path = resolve(config.root, config.sim);
  if (!existsSync(path)) throw new CliError("SIM_MISSING", `sim module ${config.sim} does not exist`, "create it with defineSim from dotframe/src/sim", "core");
  return path;
}

export async function loadSim(config: Config): Promise<Sim> {
  const mod = (await import(simPath(config))) as { default?: Sim };
  if (!mod.default || typeof mod.default.create !== "function") throw new CliError("BAD_SIM", `${config.sim} must default-export defineSim({...})`, "see dotframe skills get core", "core");
  return mod.default;
}

export async function headlessRun(sim: Sim, root: string): Promise<SimRun> {
  resetStubGpu();
  const run = sim.create({ gpu: stubGpu, load: async (p: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(resolve(root, p)).arrayBuffer()), headless: true });
  await run.ready;
  return run;
}

export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

export interface InputSource {
  // Encoded inputs per frame, one number per player.
  at: (frame: number) => number[];
  describe: string;
}

// JSONL lines are either [p0, p1, ...] (one line per frame) or {"frame": N, "inputs": [...]} (held until the next).
export function inputsFromFile(sim: Sim, path: string): InputSource {
  if (!existsSync(path)) throw new CliError("INPUTS_MISSING", `inputs file ${path} does not exist`, "pass --inputs <file.jsonl> or --mash <seed>");
  const keyed: { frame: number; inputs: number[] }[] = [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l: string): boolean => l.trim() !== "");
  lines.forEach((line: string, i: number): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CliError("BAD_INPUTS", `${path}:${i + 1} is not JSON`, "one JSON array or {frame, inputs} object per line");
    }
    const entry = Array.isArray(parsed) ? { frame: i, inputs: parsed } : (parsed as { frame: number; inputs: unknown[] });
    if (!Array.isArray(entry.inputs) || entry.inputs.length !== sim.players) {
      throw new CliError("BAD_INPUTS", `${path}:${i + 1} needs ${sim.players} inputs`, "one input per player");
    }
    keyed.push({ frame: entry.frame, inputs: entry.inputs.map((v: unknown): number => (typeof v === "number" ? v : sim.encode(v))) });
  });
  keyed.sort((a, b): number => a.frame - b.frame);
  const neutral = new Array(sim.players).fill(sim.neutral);
  return {
    describe: path,
    at: (frame: number): number[] => {
      let cur = neutral;
      for (const k of keyed) {
        if (k.frame > frame) break;
        cur = k.inputs;
      }
      return cur;
    },
  };
}

// Mashing players: a new random input per player every 6 frames.
export function mash(sim: Sim, seed: number): InputSource {
  const cache: number[][] = [];
  const next = lcg(seed);
  return {
    describe: `mash:${seed}`,
    at: (frame: number): number[] => {
      while (cache.length <= frame) {
        const f = cache.length;
        cache.push(f % 6 === 0 ? Array.from({ length: sim.players }, (): number => sim.random(next)) : cache[f - 1].slice());
      }
      return cache[frame];
    },
  };
}

export function inputSource(sim: Sim, root: string, inputs: string | undefined, mashSeed: string | undefined): InputSource {
  if (inputs) return inputsFromFile(sim, resolve(process.cwd(), inputs));
  if (mashSeed !== undefined) return mash(sim, num("mash", mashSeed, 0));
  return { describe: "neutral", at: (): number[] => new Array(sim.players).fill(sim.neutral) };
}

export function parseOptions(sim: Sim, raw: string | undefined): Record<string, unknown> {
  if (!raw) return { ...sim.options };
  try {
    return { ...sim.options, ...(JSON.parse(raw) as Record<string, unknown>) };
  } catch {
    throw new CliError("BAD_OPTIONS", "--options must be a JSON object", `example: --options '${JSON.stringify(sim.options)}'`);
  }
}

// Flattens an object graph into path -> primitive, in key order, visiting each object once. Functions and typed
// arrays are skipped (closures and pixel data are not comparable state).
export function flatten(root: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "function") return;
    if (v === null || typeof v !== "object") {
      out.set(path, typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
      return;
    }
    if (seen.has(v) || ArrayBuffer.isView(v)) return;
    seen.add(v);
    if (v instanceof Map) {
      out.set(`${path}.size`, v.size);
      for (const [k, item] of v) walk(item, `${path}[${String(k)}]`);
    } else if (v instanceof Set) out.set(`${path}.size`, v.size);
    else for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], `${path}.${k}`);
  };
  walk(root, "state");
  return out;
}

export function firstDifference(a: Map<string, unknown>, b: Map<string, unknown>): string {
  for (const [k, v] of a) {
    if (!b.has(k)) return `${k}: missing`;
    const w = b.get(k);
    if (v !== w && !(Number.isNaN(v) && Number.isNaN(w))) return `${k}: ${String(v)} vs ${String(w)}`;
  }
  for (const k of b.keys()) if (!a.has(k)) return `${k}: extra`;
  return "";
}
