import { expect, test } from "bun:test";
import { spatial } from "../src/audio";

// Listener at the origin facing -z (yaw 0): its right is +x.
test("pans toward the side the source is on and fades with distance", () => {
  const right = spatial(0, 0, 0, 5, 0, 10);
  const left = spatial(0, 0, 0, -5, 0, 10);
  const ahead = spatial(0, 0, 0, 0, -5, 10);
  expect(right.pan).toBeGreaterThan(0.5);
  expect(left.pan).toBeLessThan(-0.5);
  expect(Math.abs(ahead.pan)).toBeLessThan(1e-6);
  expect(right.volume).toBeCloseTo(0.25, 5);
  expect(spatial(0, 0, 0, 20, 0, 10).volume).toBe(0);
});

test("turning around swaps the sides", () => {
  expect(spatial(0, 0, Math.PI, 5, 0, 10).pan).toBeLessThan(-0.5);
});
