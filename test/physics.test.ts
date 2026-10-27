import { expect, test } from "bun:test";
import { vec3 } from "../src/math";
import {
  type Body,
  FIXED_STEP,
  type Solid,
  stepBodies,
  stepBody,
} from "../src/physics";

const ground: Solid = { x: 0, y: -1, halfWidth: 5, halfHeight: 0.5 };

function body(x: number, y: number): Body {
  return {
    position: vec3(x, y, 0),
    velocity: vec3(0, 0, 0),
    halfWidth: 0.4,
    halfHeight: 0.6,
    onGround: false,
  };
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

test("a compound body rests on its lowest part", () => {
  const b = body(0, 3);
  // A wide top over a narrow foot: only the foot (offset -0.4, half height 0.2) reaches the ground.
  b.parts = [
    { x: 0, y: 0.2, halfWidth: 0.4, halfHeight: 0.4 },
    { x: 0, y: -0.4, halfWidth: 0.1, halfHeight: 0.2 },
  ];
  for (let i = 0; i < 120; i++) stepBody(b, [ground], -30, FIXED_STEP);
  expect(b.onGround).toBe(true);
  expect(b.position.y).toBeCloseTo(-1 + 0.5 + 0.2 + 0.4, 5);
});

test("a body passes under the overhang of a compound solid", () => {
  // Foot at x = 1.5, overhang reaching left to x = 0.5 at y 0.6..1.0: a short body walks under the overhang until
  // it meets the foot.
  const tall: Body = {
    position: vec3(1.5, -0.5 + 0.6, 0),
    velocity: vec3(0, 0, 0),
    halfWidth: 1,
    halfHeight: 0.6,
    onGround: true,
    parts: [
      { x: 0, y: -0.3, halfWidth: 0.1, halfHeight: 0.3 },
      { x: -0.5, y: 0.4, halfWidth: 0.5, halfHeight: 0.2 },
    ],
  };
  const short: Body = {
    position: vec3(-1, -0.5 + 0.2, 0),
    velocity: vec3(4, 0, 0),
    halfWidth: 0.2,
    halfHeight: 0.2,
    onGround: false,
  };
  for (let i = 0; i < 60; i++) {
    short.velocity = vec3(4, short.velocity.y, 0);
    stepBodies([short, tall], [ground], -30, FIXED_STEP);
  }
  expect(short.position.x).toBeCloseTo(1.5 - 0.1 - 0.2, 5);
  expect(tall.position.y).toBeCloseTo(0.1, 5);
});

test("a body resting on another falls when the other walks out from under it", () => {
  const bottom = body(0, -0.5 + 0.6);
  const top = body(0, 2);
  for (let i = 0; i < 30; i++)
    stepBodies([bottom, top], [ground], -30, FIXED_STEP);
  expect(top.onGround).toBe(true);
  expect(top.position.y).toBeCloseTo(-0.5 + 1.2 + 0.6, 5);
  for (let i = 0; i < 60; i++) {
    bottom.velocity = vec3(6, bottom.velocity.y, 0);
    stepBodies([bottom, top], [ground], -30, FIXED_STEP);
  }
  expect(top.position.y).toBeCloseTo(-0.5 + 0.6, 5);
});

test("a body stopped against an equal-height body stays on the ground", () => {
  // Pixel-scale numbers from a game where X resolution left a float-rounding overlap of about 1e-14, which the Y pass
  // resolved by pushing the walker under the other body.
  const floor: Solid = { x: 480, y: 20, halfWidth: 480, halfHeight: 20 };
  const walker: Body = {
    position: vec3(259.66666666666686, 110, 0),
    velocity: vec3(260, 0, 0),
    halfWidth: 57.534246575342465,
    halfHeight: 70,
    onGround: true,
  };
  const other: Solid = { x: 370, y: 110, halfWidth: 49.124797406807126, halfHeight: 70 };
  for (let i = 0; i < 30; i++) {
    walker.velocity = vec3(260, walker.velocity.y, 0);
    stepBody(walker, [floor, other], -1800, FIXED_STEP);
  }
  expect(walker.position.y).toBe(110);
  expect(walker.onGround).toBe(true);
  expect(walker.position.x).toBeCloseTo(370 - 49.124797406807126 - 57.534246575342465, 5);
});
