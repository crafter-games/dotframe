import { expect, test } from "bun:test";
import { vec3 } from "../src/math";
import { type Emitter, emitParticles, PARTICLE_FLOATS } from "../src/particles";

const smoke: Emitter = { position: vec3(0, 1, 0), rate: 10, lifetime: 2, start: 0, stop: 100, velocity: vec3(0, 0.2, 0), spread: 0.05, acceleration: vec3(0, 0.1, 0), drag: 0.5, size: [0.02, 0.2], alpha: [0.5, 0], color: vec3(0.6, 0.6, 0.6), seed: 3 };

test("particles are a pure function of time: alive count, rising, growing, fading", () => {
  const a = emitParticles(smoke, 5, []);
  expect(a / PARTICLE_FLOATS).toBe(20);
  const out: number[] = [];
  emitParticles(smoke, 5, out);
  expect(emitParticles(smoke, 5, [])).toBe(out.length);
  const again: number[] = [];
  emitParticles(smoke, 5, again);
  expect(again).toEqual(out);
  // The oldest particle (first) is higher, bigger and fainter than the newest (last).
  const last = out.length - PARTICLE_FLOATS;
  expect(out[1]).toBeGreaterThan(out[last + 1]);
  expect(out[3]).toBeGreaterThan(out[last + 3]);
  expect(out[7]).toBeLessThan(out[last + 7]);
});

test("emission stops at stop and the last particles finish their life", () => {
  const burst = { ...smoke, start: 1, stop: 1.5 };
  expect(emitParticles(burst, 0.5, [])).toBe(0);
  expect(emitParticles(burst, 1.5, []) / PARTICLE_FLOATS).toBe(6);
  expect(emitParticles(burst, 3, []) / PARTICLE_FLOATS).toBe(5);
  expect(emitParticles(burst, 3.45, []) / PARTICLE_FLOATS).toBe(1);
  expect(emitParticles(burst, 3.6, [])).toBe(0);
});

test("alpha and size follow evenly spaced keys", () => {
  const puff = { ...smoke, rate: 1, lifetime: 2, alpha: [0, 0.4, 0], size: [0.1, 0.1] };
  const out: number[] = [];
  emitParticles(puff, 1, out);
  // Particle 0 is at mid-life (peak), particle 1 just born.
  expect(out[7]).toBeCloseTo(0.4);
  expect(out[PARTICLE_FLOATS + 7]).toBeCloseTo(0);
});

test("a color ramp shades particles over their life and a radius spreads where they are born", () => {
  const fire = { ...smoke, rate: 1, lifetime: 2, velocity: vec3(0, 0, 0), spread: 0, acceleration: vec3(0, 0, 0), drag: 0, colors: [vec3(1, 0.8, 0.4), vec3(0.6, 0.1, 0.02)], radius: 0.12 };
  const out: number[] = [];
  emitParticles(fire, 1, out);
  // Particle 0 at mid-life is halfway down the ramp; particle 1, just born, has the first color.
  expect([out[4], out[5], out[6]].map((v: number): number => Math.round(v * 100) / 100)).toEqual([0.8, 0.45, 0.21]);
  expect([out[PARTICLE_FLOATS + 4], out[PARTICLE_FLOATS + 5], out[PARTICLE_FLOATS + 6]]).toEqual([1, 0.8, 0.4]);
  const many: number[] = [];
  emitParticles({ ...fire, rate: 50 }, 1.5, many);
  let spread = 0;
  for (let i = 0; i < many.length; i += PARTICLE_FLOATS) {
    const d = Math.hypot(many[i], many[i + 1] - 1, many[i + 2]);
    expect(d).toBeLessThanOrEqual(0.12 + 1e-9);
    spread = Math.max(spread, d);
  }
  expect(spread).toBeGreaterThan(0.06);
});
