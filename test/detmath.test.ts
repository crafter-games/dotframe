import { describe, expect, test } from "bun:test";
import { createChecksum } from "../src/checksum";
import { datan, datan2, dcos, dexp, dhypot, dlog, dpow, dsin, dtan } from "../src/detmath";
import golden from "./detmath-golden.json";

const XS = [-20.5, -7, -3.14159, -1.2, -0.5, -1e-9, 0, 1e-9, 0.3, 0.7853981633974483, 1, 1.5, 2.5, 3.3, 6.2, 12.75, 100.1];

function close(a: number, b: number, rel = 1e-14): boolean {
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
}

describe("detmath accuracy", () => {
  test("matches Math within a few ulps over game ranges", () => {
    for (let i = -2000; i <= 2000; i++) {
      const x = i * 0.0137;
      expect(close(dsin(x), Math.sin(x))).toBe(true);
      expect(close(dcos(x), Math.cos(x))).toBe(true);
      expect(close(datan(x), Math.atan(x))).toBe(true);
      expect(close(dexp(x / 4), Math.exp(x / 4))).toBe(true);
      expect(close(datan2(x, 1.3 - x * 0.2), Math.atan2(x, 1.3 - x * 0.2))).toBe(true);
      if (Math.abs(Math.cos(x)) > 1e-3) expect(close(dtan(x), Math.tan(x), 1e-12)).toBe(true);
      if (x > 0) {
        expect(close(dlog(x), Math.log(x))).toBe(true);
        expect(close(dpow(x, 1.7), x ** 1.7, 1e-13)).toBe(true);
      }
    }
    expect(close(dpow(1.1, 10), 1.1 ** 10)).toBe(true);
    expect(dpow(3, 4)).toBe(81);
    expect(dpow(2, -3)).toBe(0.125);
    expect(dhypot(3, 4)).toBe(5);
    expect(datan2(0, -1)).toBe(Math.PI);
    expect(datan2(-0, -1)).toBe(-Math.PI);
    expect(dlog(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(dlog(-1))).toBe(true);
  });
});

describe("detmath determinism", () => {
  // Recorded on macOS arm64. CI runs this on Linux: any platform-dependent bit fails here.
  test("produces the recorded bits on every platform", () => {
    const now = {
      sin: XS.map(dsin),
      cos: XS.map(dcos),
      tan: XS.map((x) => dtan(x)),
      atan: XS.map(datan),
      exp: XS.map((x) => dexp(x / 4)),
      log: XS.filter((x) => x > 0).map(dlog),
      atan2: XS.map((x, i) => datan2(x, XS[(i + 5) % XS.length])),
      pow: XS.filter((x) => x > 0).map((x) => dpow(x, 1.7)),
    };
    expect(now).toEqual(golden);
  });
});

describe("checksum", () => {
  test("depends on value and order, not on float noise below the scale", () => {
    const a = createChecksum().add(1).add(2.5).value();
    expect(createChecksum().add(1).add(2.5).value()).toBe(a);
    expect(createChecksum().add(2.5).add(1).value()).not.toBe(a);
    expect(createChecksum().add(1).add(2.5 + 1e-12).value()).toBe(a);
    expect(createChecksum().add(1).add(2.6).value()).not.toBe(a);
    expect(createChecksum().add(1e12).value()).not.toBe(createChecksum().add(1e12 + 4294967296).value());
  });
});
