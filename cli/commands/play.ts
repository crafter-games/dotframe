import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Draw2D } from "../../src/draw2d";
import type { Sim, SimRun } from "../../src/sim";
import { CliError, type Ctx, frames60, loadConfig, num, print } from "../lib";
import { firstDifference, flatten, headlessRun, type InputSource, inputSource, lcg, loadSim, parseOptions } from "../simkit";

export interface PlayArgs {
  inputs?: string;
  mash?: string;
  frames?: string;
  seed?: string;
  options?: string;
  every?: string;
  // Keep stepping after over(), for rematch and results flows.
  throughOver?: boolean;
}

interface Played {
  frames: number;
  over: boolean;
  checksum: number;
  trace: { frame: number; checksum: number }[];
  state: unknown;
  ms: number;
}

function play(run: SimRun, source: InputSource, frames: number, every: number, throughOver = false): Played {
  const t0 = performance.now();
  const trace: { frame: number; checksum: number }[] = [];
  let f = 0;
  for (; f < frames && (throughOver || !run.over()); f++) {
    run.step(source.at(f));
    if (every > 0 && (f + 1) % every === 0) trace.push({ frame: f + 1, checksum: run.checksum() });
  }
  return { frames: f, over: run.over(), checksum: run.checksum(), trace, state: run.state(), ms: Math.round(performance.now() - t0) };
}

async function setup(args: PlayArgs): Promise<{ sim: Sim; run: SimRun; source: InputSource; seed: number; options: Record<string, unknown>; root: string }> {
  const config = loadConfig();
  const sim = await loadSim(config);
  const seed = num("seed", args.seed, 1);
  const options = parseOptions(sim, args.options);
  const source = inputSource(sim, config.root, args.inputs, args.mash);
  const run = await headlessRun(sim, config.root);
  run.start(seed, options);
  return { sim, run, source, seed, options, root: config.root };
}

export async function sim(ctx: Ctx, args: PlayArgs): Promise<void> {
  const { run, source, seed } = await setup(args);
  const r = play(run, source, num("frames", args.frames, 600, 1), num("every", args.every, 0), args.throughOver === true);
  print(ctx, { seed, inputs: source.describe, ...r }, (): string =>
    [`${r.frames} frames in ${r.ms} ms (${source.describe}, seed ${seed})${r.over ? ", match over" : ""}`, `checksum ${r.checksum}`, JSON.stringify(r.state, null, 2)].join("\n"),
  );
}

interface Replay {
  version: 1;
  seed: number;
  options: Record<string, unknown>;
  // Encoded inputs as change points.
  inputs: { frame: number; inputs: number[] }[];
  frames: number;
  throughOver?: boolean;
  checksums: { frame: number; checksum: number }[];
  final: number;
}

export async function record(ctx: Ctx, file: string, args: PlayArgs): Promise<void> {
  if (!file) throw new CliError("MISSING_ARG", "replay record needs an output file", "dotframe replay record replays/smoke.json --mash 7 --frames 1800");
  const { run, source, seed, options } = await setup(args);
  const frames = num("frames", args.frames, 1800, 1);
  const r = play(run, source, frames, 60, args.throughOver === true);
  const inputs: Replay["inputs"] = [];
  for (let f = 0; f < r.frames; f++) {
    const cur = source.at(f);
    const last = inputs[inputs.length - 1];
    if (!last || last.inputs.some((v: number, i: number): boolean => v !== cur[i])) inputs.push({ frame: f, inputs: cur.slice() });
  }
  const replay: Replay = { version: 1, seed, options, inputs, frames: r.frames, ...(args.throughOver ? { throughOver: true } : {}), checksums: r.trace, final: r.checksum };
  writeFileSync(resolve(process.cwd(), file), `${JSON.stringify(replay)}\n`);
  print(ctx, { file, frames: r.frames, final: r.checksum, checkpoints: r.trace.length }, (): string => `recorded ${r.frames} frames to ${file} (final checksum ${r.checksum})`);
}

export async function verify(ctx: Ctx, files: string[]): Promise<void> {
  if (files.length === 0) throw new CliError("MISSING_ARG", "replay verify needs one or more replay files", "dotframe replay verify replays/*.json");
  const config = loadConfig();
  const sim = await loadSim(config);
  const results: { file: string; ok: boolean; firstMismatch: number | null; expected: number; got: number }[] = [];
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) throw new CliError("REPLAY_MISSING", `${file} does not exist`, "record one with dotframe replay record");
    const replay = JSON.parse(readFileSync(path, "utf8")) as Replay;
    const run = await headlessRun(sim, config.root);
    run.start(replay.seed, replay.options);
    const source: InputSource = {
      describe: file,
      at: (frame: number): number[] => {
        let cur = replay.inputs[0]?.inputs ?? [];
        for (const k of replay.inputs) {
          if (k.frame > frame) break;
          cur = k.inputs;
        }
        return cur;
      },
    };
    const r = play(run, source, replay.frames, 60, replay.throughOver === true);
    const mismatch = replay.checksums.find((c, i): boolean => r.trace[i]?.checksum !== c.checksum);
    results.push({ file, ok: !mismatch && r.checksum === replay.final, firstMismatch: mismatch ? mismatch.frame : r.checksum === replay.final ? null : r.frames, expected: replay.final, got: r.checksum });
  }
  const failed = results.filter((r): boolean => !r.ok);
  print(ctx, { results, failed: failed.length }, (): string =>
    results.map((r): string => (r.ok ? `ok   ${r.file}` : `FAIL ${r.file}: diverges by frame ${r.firstMismatch}`)).join("\n"),
  );
  if (failed.length > 0) process.exit(1);
}

// A Draw2D that accepts every call and draws nothing, so render paths run headless.
const stubDraw: Draw2D = new Proxy({} as Draw2D, {
  get: (_t: Draw2D, key: string | symbol): unknown => {
    if (key === "measureText") return (): { width: number } => ({ width: 10 });
    if (key === "getGlobalAlpha") return (): number => 1;
    return (): void => {};
  },
});

export interface DesyncArgs extends PlayArgs {
  latency?: string;
  jitter?: string;
  delay?: string;
  renders?: string;
}

// Each peer runs its own rollback loop against a deterministic arrival schedule, one after the other, so peers never
// share module state. Peer 1 also renders between steps: rendering must not change the simulation.
export async function desync(ctx: Ctx, args: DesyncArgs): Promise<void> {
  const config = loadConfig();
  const sim = await loadSim(config);
  if (sim.players !== 2) throw new CliError("UNSUPPORTED", "desync simulates two peers; this sim has " + sim.players + " players", "", "netplay");
  const frames = num("frames", args.frames, 1800, 1);
  const seed = num("seed", args.seed, 1);
  const latency = frames60("latency", args.latency, 100);
  const jitter = frames60("jitter", args.jitter, 0);
  const delay = num("delay", args.delay, 2);
  const renders = num("renders", args.renders, 3);
  const every = num("every", args.every, 30, 1);
  const options = parseOptions(sim, args.options);
  const source = inputSource(sim, config.root, args.inputs, args.mash ?? (args.inputs ? undefined : "7"));
  // Input a player presses at frame f applies at frame f + delay, on both peers.
  const applied = (frame: number, player: number): number => (frame < delay ? sim.neutral : source.at(frame - delay)[player]);

  const reference = await headlessRun(sim, config.root);
  reference.start(seed, options);
  const truth: number[] = [];
  const truthState = new Map<number, Map<string, unknown>>();
  for (let f = 0; f < frames; f++) {
    reference.step([applied(f, 0), applied(f, 1)]);
    truth.push(reference.checksum());
    if (reference.inspect && f % every === 0) truthState.set(f, flatten(reference.inspect()));
  }

  const peer = async (self: number): Promise<{ checksums: number[]; states: Map<number, string>; rollbacks: number; maxDepth: number; restores: { frame: number; ms: number }[] }> => {
    const other = 1 - self;
    const noise = lcg(seed * 31 + other);
    // Arrival tick of the remote input for each frame, in order, as the link test does.
    const arrival: number[] = [];
    let last = 0;
    for (let f = 0; f < frames; f++) {
      const sent = Math.max(0, f - delay);
      last = Math.max(last, sent + latency + (jitter > 0 ? Math.floor(noise() * (jitter + 1)) : 0));
      arrival.push(last);
    }
    const run = await headlessRun(sim, config.root);
    run.start(seed, options);
    const snaps: unknown[] = [];
    const used: number[] = [];
    const known: (number | undefined)[] = [];
    const checksums: number[] = [];
    // First differing path per checkpoint frame; overwritten when a rollback resimulates the frame.
    const states = new Map<number, string>();
    let rollbacks = 0;
    let maxDepth = 0;
    // Time per restore by the frame it restores to: a restore that replays from frame 0 grows with the match.
    const restores: { frame: number; ms: number }[] = [];
    let next = 0;
    let lastKnown = sim.neutral;
    const stepFrame = (f: number): void => {
      snaps[f] = run.save();
      const remote = known[f] ?? lastKnown;
      used[f] = remote;
      const inputs = [sim.neutral, sim.neutral];
      inputs[self] = applied(f, self);
      inputs[other] = remote;
      run.step(inputs);
      checksums[f] = run.checksum();
      if (self === 1 && run.render) for (let r = 0; r < renders; r++) run.render(stubDraw);
      const want = truthState.get(f);
      if (want && run.inspect) states.set(f, firstDifference(want, flatten(run.inspect())));
    };
    for (let t = 0; t < frames + latency + jitter + 1; t++) {
      let rollbackFrom = -1;
      while (next < frames && arrival[next] <= t) {
        const value = applied(next, other);
        known[next] = value;
        lastKnown = value;
        if (next < checksums.length && used[next] !== value && rollbackFrom < 0) rollbackFrom = next;
        next += 1;
      }
      const simulated = checksums.length;
      if (rollbackFrom >= 0) {
        rollbacks += 1;
        maxDepth = Math.max(maxDepth, simulated - rollbackFrom);
        const t0 = performance.now();
        run.restore(snaps[rollbackFrom]);
        restores.push({ frame: rollbackFrom, ms: performance.now() - t0 });
        for (let f = rollbackFrom; f < simulated; f++) stepFrame(f);
      }
      if (t < frames) stepFrame(t);
    }
    return { checksums, states, rollbacks, maxDepth, restores };
  };

  const peers = [await peer(0), await peer(1)];
  const firstDiff = (a: number[]): number => a.findIndex((c: number, f: number): boolean => c !== truth[f]);
  const firstState = (states: Map<number, string>): { frame: number; path: string } | null => {
    for (const [frame, path] of [...states].sort((a, b): number => a[0] - b[0])) if (path !== "") return { frame, path };
    return null;
  };
  const report = peers.map((p, i) => ({
    peer: i,
    rendersBetweenSteps: i === 1 ? renders : 0,
    firstDivergentFrame: firstDiff(p.checksums),
    // State differences the checksum may miss; null when the sim has no inspect().
    firstStateDifference: reference.inspect ? firstState(p.states) : null,
    rollbacks: p.rollbacks,
    maxRollbackFrames: p.maxDepth,
  }));
  const ok = report.every((r): boolean => r.firstDivergentFrame < 0 && r.firstStateDifference === null);
  const deepest = Math.max(...report.map((r): number => r.maxRollbackFrames));
  const warnings: string[] = [];
  if (sim.rollbackWindow !== undefined && deepest > sim.rollbackWindow) {
    warnings.push(`this link needed ${deepest}-frame rollbacks but the game's window is ${sim.rollbackWindow}: real play would stall`);
  }
  if (!sim.rollbackWindow) warnings.push("the sim declares no rollbackWindow, so rollback depth is not checked against the game");
  // Restore cost early vs late in the run (first and last tenth of the rollbacks). Heuristic: when late restores cost
  // more than twice the early ones, restore probably replays from an earlier point, and real rollbacks will stall
  // late in a match even though desync passes.
  const restores = peers[0].restores;
  const tenth = Math.max(1, Math.floor(restores.length / 10));
  const mean = (xs: { ms: number }[]): number => xs.reduce((a, r) => a + r.ms, 0) / Math.max(1, xs.length);
  const restoreMs = { early: mean(restores.slice(0, tenth)), late: mean(restores.slice(-tenth)) };
  if (restores.length >= 20 && restoreMs.late > 2 * restoreMs.early) {
    warnings.push(`restore cost grows with the frame: ${restoreMs.early.toFixed(3)} ms early vs ${restoreMs.late.toFixed(3)} ms late; restore should copy a snapshot, not replay`);
  }
  print(ctx, { ok, warnings, restoreMs, frames, latencyFrames: latency, jitterFrames: jitter, delay, inputs: source.describe, peers: report }, (): string =>
    [
      `${frames} frames, latency ${latency}f, jitter ${jitter}f, delay ${delay}f (${source.describe})`,
      ...report.map((r): string => {
        const sync = r.firstDivergentFrame >= 0 ? `DESYNC (checksum) at frame ${r.firstDivergentFrame}` : r.firstStateDifference ? `STATE DIFFERS at frame ${r.firstStateDifference.frame}: ${r.firstStateDifference.path}` : "in sync";
        return `peer ${r.peer}${r.rendersBetweenSteps ? " (renders)" : ""}: ${sync}, ${r.rollbacks} rollbacks, max ${r.maxRollbackFrames}f`;
      }),
      reference.inspect ? "" : "note: the sim has no inspect(), so only the checksum is compared",
      ...warnings.map((w: string): string => `warning: ${w}`),
    ].filter(Boolean).join("\n"),
  );
  if (!ok) process.exit(1);
}
