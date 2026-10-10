// Particles as a pure function of time: an emitter spawns particle k at k / rate seconds, and where it is at time
// t follows from its age and a per-particle random draw. Nothing is stored between frames, so a frame renders the
// same twice, snap and replays reproduce it, and rollback needs nothing. Presentation only: feed the result to
// Environment.particles in render, never into simulation state.
import { dcos, dexp, dsin } from "./detmath";
import type { Vec3 } from "./math";

// Floats per particle in Environment.particles: x, y, z, size, r, g, b, alpha.
export const PARTICLE_FLOATS = 8;

export interface Emitter {
  position: Vec3;
  // Particles per second, and how long each lives (seconds).
  rate: number;
  lifetime: number;
  // Seconds of emitter time when emission starts and stops; particles already out finish their life.
  start: number;
  stop: number;
  // Initial velocity, plus a random velocity up to spread in every direction (m/s).
  velocity: Vec3;
  spread: number;
  // Constant acceleration: negative y falls, positive y rises (smoke).
  acceleration: Vec3;
  // Fraction of velocity lost per second (air drag), 0 for none.
  drag: number;
  // Size (world units, diameter) and alpha over the life: keys evenly spaced from birth to death, interpolated
  // linearly ([0, 0.3, 0] fades in to 0.3 at mid-life and out again; two or more keys).
  size: number[];
  alpha: number[];
  color: Vec3;
  // Color over the life instead of one color, keyed like size and alpha (Godot's color_ramp).
  colors?: Vec3[];
  // Particles are born at a random point within this distance of position (a sphere), not all at its center.
  radius?: number;
  // Different seeds give different particles from the same settings.
  seed: number;
}

// Appends every particle alive at time t to out, returns the new length.
export function emitParticles(e: Emitter, t: number, out: number[]): number {
  if (e.rate <= 0 || e.lifetime <= 0) return out.length;
  const first = Math.max(0, Math.ceil((Math.max(e.start, t - e.lifetime) - e.start) * e.rate));
  const last = Math.floor((Math.min(e.stop, t) - e.start) * e.rate);
  for (let k = first; k <= last; k++) {
    const age = t - (e.start + k / e.rate);
    if (age < 0 || age >= e.lifetime) continue;
    const u = age / e.lifetime;
    const rx = (hash(e.seed, k, 1) * 2 - 1) * e.spread;
    const ry = (hash(e.seed, k, 2) * 2 - 1) * e.spread;
    const rz = (hash(e.seed, k, 3) * 2 - 1) * e.spread;
    // Distance travelled under drag: v (1 - e^-dt) / d, or v t without drag.
    const travel = e.drag > 0 ? (1 - dexp(-e.drag * age)) / e.drag : age;
    const half = 0.5 * age * age;
    const born = e.radius ? ball(e.seed, k, e.radius) : ZERO;
    const c = e.colors && e.colors.length > 0 ? ramp(e.colors, u) : e.color;
    out.push(
      e.position.x + born[0] + (e.velocity.x + rx) * travel + e.acceleration.x * half,
      e.position.y + born[1] + (e.velocity.y + ry) * travel + e.acceleration.y * half,
      e.position.z + born[2] + (e.velocity.z + rz) * travel + e.acceleration.z * half,
      curve(e.size, u),
      c.x,
      c.y,
      c.z,
      curve(e.alpha, u),
    );
  }
  return out.length;
}

const ZERO = [0, 0, 0];

// A point inside a ball of radius r: a uniform direction from two draws, the distance from a third (square root,
// so a little denser toward the center than a uniform volume; sqrt is exact on every platform, unlike cbrt).
function ball(seed: number, k: number, r: number): number[] {
  const z = hash(seed, k, 4) * 2 - 1;
  const a = hash(seed, k, 5) * Math.PI * 2;
  const d = r * Math.sqrt(hash(seed, k, 6));
  const s = Math.sqrt(1 - z * z) * d;
  return [dcos(a) * s, z * d, dsin(a) * s];
}

function ramp(keys: Vec3[], u: number): Vec3 {
  if (keys.length === 1) return keys[0];
  const x = u * (keys.length - 1);
  const i = Math.min(Math.floor(x), keys.length - 2);
  const f = x - i;
  const a = keys[i];
  const b = keys[i + 1];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

function curve(keys: number[], u: number): number {
  if (keys.length < 2) return keys.length === 1 ? keys[0] : 0;
  const x = u * (keys.length - 1);
  const i = Math.min(Math.floor(x), keys.length - 2);
  return keys[i] + (keys[i + 1] - keys[i]) * (x - i);
}

// A stable random number in [0, 1) for particle k of an emitter.
function hash(seed: number, k: number, channel: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35) ^ Math.imul(channel, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
