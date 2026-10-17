import { expect, test } from "bun:test";
import { createKeyLatch } from "../src/web/keys";

test("a tap in a frame with no step reads as down in the next frame", () => {
  const keys = createKeyLatch();
  keys.press("Space");
  keys.release("Space");
  keys.endFrame();
  expect(keys.down("Space")).toBe(true);
  keys.endFrame();
  expect(keys.down("Space")).toBe(false);
});

test("a tap read in its own frame is gone after it", () => {
  const keys = createKeyLatch();
  keys.press("Space");
  keys.release("Space");
  expect(keys.down("Space")).toBe(true);
  expect(keys.down("Space")).toBe(true);
  keys.endFrame();
  expect(keys.down("Space")).toBe(false);
});

test("a held key stays down until released", () => {
  const keys = createKeyLatch();
  keys.press("KeyA");
  expect(keys.down("KeyA")).toBe(true);
  keys.endFrame();
  expect(keys.down("KeyA")).toBe(true);
  keys.release("KeyA");
  expect(keys.down("KeyA")).toBe(false);
});

test("blur drops every key, pending taps included", () => {
  const keys = createKeyLatch();
  keys.press("KeyA");
  keys.press("Space");
  keys.release("Space");
  keys.clear();
  keys.endFrame();
  expect(keys.down("KeyA")).toBe(false);
  expect(keys.down("Space")).toBe(false);
});
