import { expect, test } from "bun:test";
import { mipChain } from "../src/mips";

test("halves down to 1x1 with a rounded box filter, clamping odd edges", () => {
  // 3x2: one white pixel among black ones.
  const rgba = new Uint8Array(3 * 2 * 4);
  rgba.set([255, 255, 255, 255], 0);
  const levels = mipChain(3, 2, rgba);
  expect(levels.map((l) => [l.width, l.height])).toEqual([
    [3, 2],
    [1, 1],
  ]);
  // The 1x1 averages the top-left 2x2 block: (255 + 0 + 0 + 0 + 2) >> 2.
  expect(levels[1].data[0]).toBe(64);
  expect(mipChain(512, 512, new Uint8Array(512 * 512 * 4)).length).toBe(10);
});
