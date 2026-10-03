import { expect, test } from "bun:test";
import { parseColor, parseFont, triangulate } from "../src/draw2d";

test("parses hex, rgb, rgba and named colors", () => {
  expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  expect(parseColor("#ff000080").a).toBeCloseTo(128 / 255, 5);
  expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
  expect(parseColor("rgb(0, 255, 0)")).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  expect(parseColor("White")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
});

function area(points: number[], indices: number[]): number {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    total += Math.abs(
      (points[b * 2] - points[a * 2]) * (points[c * 2 + 1] - points[a * 2 + 1]) -
        (points[b * 2 + 1] - points[a * 2 + 1]) * (points[c * 2] - points[a * 2]),
    ) / 2;
  }
  return total;
}

test("triangulates a convex square into two triangles covering its area", () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const indices = triangulate(square);
  expect(indices.length).toBe(6);
  expect(area(square, indices)).toBeCloseTo(100, 6);
});

test("triangulates a concave L shape without covering the notch", () => {
  // 3x3 square minus the top-right 2x2 quadrant: area 5.
  const shape = [0, 0, 1, 0, 1, 2, 3, 2, 3, 3, 0, 3];
  const indices = triangulate(shape);
  expect(indices.length).toBe(12);
  expect(area(shape, indices)).toBeCloseTo(5, 6);
});

test("handles clockwise winding the same as counterclockwise", () => {
  const clockwise = [0, 10, 10, 10, 10, 0, 0, 0];
  expect(area(clockwise, triangulate(clockwise))).toBeCloseTo(100, 6);
});

test("parses CSS font shorthands used by Canvas2D games", () => {
  expect(parseFont('italic 900 24px "Arial Black", Impact, sans-serif')).toEqual({
    size: 24,
    italic: true,
    families: ["arial black", "impact", "sans-serif"],
  });
  expect(parseFont("72px Bangers, Impact")).toEqual({ size: 72, italic: false, families: ["bangers", "impact"] });
  expect(parseFont("bold 9.5px Menlo, monospace").size).toBe(9.5);
});
