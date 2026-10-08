import { expect, test } from "bun:test";
import { metrics } from "../cli/commands/compare";

test("compare metrics: zero for the same picture, and the darker cell where the port is darker", () => {
  const w = 6;
  const h = 6;
  const gray = new Uint8Array(w * h * 3).fill(128);
  expect(metrics(gray, gray, w, h).mae).toBe(0);
  const port = gray.slice();
  // Top-left 2x2 cell black in the port.
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) port.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
  const m = metrics(port, gray, w, h);
  expect(m.grid[0][0]).toBeCloseTo(-0.502, 2);
  expect(m.grid[1][1]).toBe(0);
  expect(m.port).toBeLessThan(m.reference);
});
