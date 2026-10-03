import { expect, test } from "bun:test";
import { vec3 } from "../src/math";
import { type Body, FIXED_STEP, type Solid, stepBody } from "../src/physics";

const ground: Solid = { x: 0, y: -1, halfWidth: 5, halfHeight: 0.5 };

function body(x: number, y: number): Body {
  return { position: vec3(x, y, 0), velocity: vec3(0, 0, 0), halfWidth: 0.4, halfHeight: 0.6, onGround: false };
}

test("a falling body lands on top of a solid", () => {
  const b = body(0, 3);
  for (let i = 0; i < 120; i++) stepBody(b, [ground], -30, FIXED_STEP);
  expect(b.onGround).toBe(true);
  expect(b.position.y).toBeCloseTo(-1 + 0.5 + 0.6, 5);
  expect(b.velocity.y).toBe(0);
});

test("a body moving sideways stops at a wall", () => {
  const wall: Solid = { x: 2, y: 0, halfWidth: 0.5, halfHeight: 2 };
  const b = body(0, -0.1);
  b.velocity = vec3(8, 0, 0);
  for (let i = 0; i < 60; i++) stepBody(b, [ground, wall], -30, FIXED_STEP);
  expect(b.position.x).toBeCloseTo(2 - 0.5 - 0.4, 5);
  expect(b.velocity.x).toBe(0);
});

test("a body jumping into a ceiling is pushed below it", () => {
  const ceiling: Solid = { x: 0, y: 2, halfWidth: 3, halfHeight: 0.2 };
  const b = body(0, 0);
  b.velocity = vec3(0, 15, 0);
  for (let i = 0; i < 20; i++) stepBody(b, [ceiling], -30, FIXED_STEP);
  expect(b.position.y).toBeLessThanOrEqual(2 - 0.2 - 0.6 + 1e-9);
  expect(b.onGround).toBe(false);
});

test("a body off the edge keeps falling", () => {
  const b = body(10, 0);
  for (let i = 0; i < 60; i++) stepBody(b, [ground], -30, FIXED_STEP);
  expect(b.onGround).toBe(false);
  expect(b.position.y).toBeLessThan(-10);
});
