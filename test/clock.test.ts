import { expect, test } from "bun:test";
import { createClock, MAX_GAP } from "../src/clock";

test("the clock follows real time and skips long gaps", () => {
  let now = 10;
  const clock = createClock((): number => now);
  now += 0.016;
  expect(clock()).toBeCloseTo(0.016);
  now += 5;
  expect(clock()).toBeCloseTo(0.016 + MAX_GAP);
  now += 0.016;
  expect(clock()).toBeCloseTo(0.032 + MAX_GAP);
});
