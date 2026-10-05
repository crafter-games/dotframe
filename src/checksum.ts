// A checksum over simulation numbers in a fixed order. Netplay peers compare it every few frames, so it must not
// depend on object key order (JSON.stringify differs between JavaScript and scriptc builds) or on float printing.
export interface Checksum {
  // Adds a number, rounded to `scale` (default 1e-6 resolution) so harmless float noise does not count.
  add: (value: number) => Checksum;
  value: () => number;
}

export function createChecksum(scale = 1e6): Checksum {
  let h = 2166136261;
  const sum: Checksum = {
    add: (value: number): Checksum => {
      const v = Number.isNaN(value) ? 0x7ff8 : Math.round(value * scale);
      // Low and high 32 bits, so large values still change the hash.
      h = Math.imul(h ^ (v | 0), 16777619);
      h = Math.imul(h ^ Math.floor(v / 4294967296), 16777619);
      return sum;
    },
    value: (): number => h >>> 0,
  };
  return sum;
}
