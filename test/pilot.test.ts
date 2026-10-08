import { describe, expect, test } from "bun:test";
import { runPlan } from "../cli/pilot";
import type { Sim, SimRun } from "../src/sim";

// A walker on a plane: forward is -z at yaw 0, a look byte turns 0.01 rad, bit 1 walks 0.05 m, bit 2 is use.
function walker(): { sim: Sim; run: SimRun } {
  const p = { x: 0, z: 0, yaw: 0, pitch: 0, used: 0 };
  const run: SimRun = {
    ready: Promise.resolve(),
    start: (): void => {},
    step: ([v]: number[]): void => {
      p.yaw -= ((((v >> 8) & 255) << 24) >> 24) * 0.01;
      p.pitch -= ((((v >> 16) & 255) << 24) >> 24) * 0.01;
      if (v & 1) {
        p.x -= Math.sin(p.yaw) * 0.05;
        p.z -= Math.cos(p.yaw) * 0.05;
      }
      if (v & 2) p.used++;
    },
    checksum: (): number => 0,
    state: (): unknown => ({ used: p.used, at: [Math.round(p.x), Math.round(p.z)] }),
    over: (): boolean => false,
    save: (): unknown => ({ ...p }),
    restore: (): void => {},
    pose: () => ({ x: p.x, y: 1.6, z: p.z, yaw: p.yaw, pitch: p.pitch }),
  };
  const byte = (r: number): number => Math.max(-127, Math.min(127, Math.round(-r / 0.01))) & 255;
  const sim: Sim = {
    players: 1,
    window: { width: 1, height: 1, title: "" },
    options: {},
    encode: (): number => 0,
    neutral: 0,
    random: (): number => 0,
    create: (): SimRun => run,
    pilot: { yawTo: (dx: number, dz: number): number => Math.atan2(-dx, -dz), turn: 1.27, input: (m): number => (m.forward ? 1 : 0) | (m.use || m.buttons.includes("use") ? 2 : 0) | (byte(m.yaw) << 8) | (byte(m.pitch) << 16) },
  };
  return { sim, run };
}

describe("replay plan", () => {
  test("walks to points, aims, presses and checks state", () => {
    const { sim, run } = walker();
    const r = runPlan(sim, run, [{ go: [3, 4] }, { go: [-2, 1] }, { look: [-2, 1.6, -5] }, { press: 3 }, { expect: "used", is: 3 }, { wait: { until: "at", is: [-2, 1] } }]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    const p = run.pose?.();
    expect(Math.hypot((p?.x ?? 0) + 2, (p?.z ?? 0) - 1)).toBeLessThan(0.15);
    const yaw = p?.yaw ?? 1;
    expect(Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw)))).toBeLessThan(0.02);
    expect(r.inputs.length).toBeGreaterThan(100);
  });

  test("holds named buttons through a step", () => {
    const { sim, run } = walker();
    const r = runPlan(sim, run, [{ wait: 4, with: ["use"] }, { expect: "used", is: 4 }]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  test("stops at the first failed step", () => {
    const { sim, run } = walker();
    const r = runPlan(sim, run, [{ press: 1 }, { expect: "used", is: 2 }, { go: [5, 5] }]);
    expect(r.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(r.steps[1].detail).toContain("expected 2");
  });
});
