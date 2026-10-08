import { existsSync, readFileSync } from "node:fs";
import type { Sim, SimRun } from "../src/sim";
import { CliError } from "./lib";

// A replay plan: what player 0 does, step by step, for replay record --plan. Walking and aiming are steered from the
// game's own pose each frame, so a plan survives a change in walk speed or a moved spawn where hand-tuned inputs
// do not.
export type PlanStep =
  | { go: [number, number]; within?: number; stop?: number }
  | { look: [number, number, number] }
  | { press: number }
  | { wait: number | { until: string; is: unknown; max?: number } }
  | { expect: string; is: unknown };

export interface PlanResult {
  inputs: number[];
  steps: { step: number; kind: string; frame: number; ok: boolean; detail: string }[];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

// state() at a dotted path ("story.seen", "npcs.0.clip").
function at(state: unknown, path: string): unknown {
  let cur: unknown = state;
  for (const key of path.split(".")) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
  return cur;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function readPlan(path: string): PlanStep[] {
  if (!existsSync(path)) throw new CliError("PLAN_MISSING", `plan ${path} does not exist`, "write a JSON array of steps: go, look, press, wait, expect");
  const plan = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(plan)) throw new CliError("BAD_PLAN", `${path} must be a JSON array of steps`, '[{"go": [0, 4]}, {"look": [0, 1, 6]}, {"press": 2}]');
  return plan as PlanStep[];
}

// Runs the plan on a started run, stepping it, and returns the inputs it used. Stops at the first step that fails.
export function runPlan(sim: Sim, run: SimRun, plan: PlanStep[]): PlanResult {
  const pilot = sim.pilot;
  const pose = run.pose;
  if (!pilot || !pose) throw new CliError("NO_PILOT", "this sim has no pilot: replay record --plan needs Sim.pilot and SimRun.pose", "add pilot (yawTo, turn, input) to defineSim and pose() to the run; see dotframe skills get core");
  if (sim.players !== 1) throw new CliError("UNSUPPORTED", "replay record --plan steers one player; this sim has " + sim.players, "record multiplayer replays with --inputs");
  const inputs: number[] = [];
  const steps: PlanResult["steps"] = [];
  const push = (v: number): void => {
    run.step([v]);
    inputs.push(v);
  };
  const clamp = (v: number): number => Math.max(-pilot.turn, Math.min(pilot.turn, v));
  for (const [i, step] of plan.entries()) {
    const start = inputs.length;
    let ok = true;
    let detail = "";
    let kind = "";
    if ("go" in step) {
      kind = "go";
      const within = step.within ?? 0.1;
      ok = false;
      for (let k = 0; k < 6000; k++) {
        const p = pose();
        const dx = step.go[0] - p.x;
        const dz = step.go[1] - p.z;
        if (Math.hypot(dx, dz) < within) {
          ok = true;
          break;
        }
        const d = wrap(pilot.yawTo(dx, dz) - p.yaw);
        push(pilot.input({ forward: Math.abs(d) < 0.3, yaw: clamp(d), pitch: 0, use: false }));
      }
      for (let k = 0; k < (step.stop ?? 30); k++) push(pilot.input({ forward: false, yaw: 0, pitch: 0, use: false }));
      const p = pose();
      detail = `at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`;
      if (!ok) detail = `did not reach ${step.go.join(", ")} (stuck ${detail})`;
    } else if ("look" in step) {
      kind = "look";
      for (let k = 0; k < 240; k++) {
        const p = pose();
        const dx = step.look[0] - p.x;
        const dy = step.look[1] - p.y;
        const dz = step.look[2] - p.z;
        const yaw = wrap(pilot.yawTo(dx, dz) - p.yaw);
        const pitch = Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch;
        if (Math.abs(yaw) < 0.005 && Math.abs(pitch) < 0.005) break;
        push(pilot.input({ forward: false, yaw: clamp(yaw), pitch: clamp(pitch), use: false }));
      }
    } else if ("press" in step) {
      kind = "press";
      for (let k = 0; k < step.press; k++) push(pilot.input({ forward: false, yaw: 0, pitch: 0, use: true }));
      push(pilot.input({ forward: false, yaw: 0, pitch: 0, use: false }));
    } else if ("wait" in step) {
      kind = "wait";
      const idle = pilot.input({ forward: false, yaw: 0, pitch: 0, use: false });
      if (typeof step.wait === "number") for (let k = 0; k < step.wait; k++) push(idle);
      else {
        const w = step.wait;
        ok = false;
        for (let k = 0; k < (w.max ?? 6000); k++) {
          if (same(at(run.state(), w.until), w.is)) {
            ok = true;
            break;
          }
          push(idle);
        }
        if (!ok) detail = `${w.until} is ${JSON.stringify(at(run.state(), w.until))}, not ${JSON.stringify(w.is)}, after ${w.max ?? 6000} frames`;
      }
    } else if ("expect" in step) {
      kind = "expect";
      const got = at(run.state(), step.expect);
      ok = same(got, step.is) || (Array.isArray(got) && !Array.isArray(step.is) && got.some((v: unknown): boolean => same(v, step.is)));
      if (!ok) detail = `${step.expect} is ${JSON.stringify(got)}, expected ${JSON.stringify(step.is)}`;
    } else throw new CliError("BAD_PLAN", `step ${i} is not one of go, look, press, wait, expect: ${JSON.stringify(step)}`, '{"go": [x, z]} | {"look": [x, y, z]} | {"press": frames} | {"wait": frames | {"until": "state.path", "is": value}} | {"expect": "state.path", "is": value}');
    steps.push({ step: i, kind, frame: start, ok, detail });
    if (!ok) break;
  }
  return { inputs, steps };
}
