import { expect, test } from "bun:test";
import { stats } from "../cli/commands/perf";

test("perf stats: p50, p95 and max of frame times", () => {
  const values = Array.from({ length: 100 }, (_: unknown, i: number): number => i + 1);
  expect(stats(values)).toEqual({ p50: 51, p95: 96, max: 100 });
  expect(stats([])).toEqual({ p50: 0, p95: 0, max: 0 });
});
