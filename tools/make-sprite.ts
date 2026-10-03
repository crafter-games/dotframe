// Generates assets/crafter.png: a 16x16 two-frame pixel-art character sheet (32x16), original art.
import { deflateSync } from "node:zlib";

const art = [
  [
    "................",
    ".....oooooo.....",
    "....oooooooo....",
    "....ossssssso...",
    "....osskskkso...",
    "....ossssssso...",
    ".....ossssso....",
    "......bbbb......",
    "....bbbbbbbb....",
    "...sbbbbbbbbs...",
    "...sbbbbbbbbs...",
    "....bbbbbbbb....",
    "....ddd..ddd....",
    "....ddd..ddd....",
    "....kkk..kkk....",
    "................",
  ],
  [
    "................",
    ".....oooooo.....",
    "....oooooooo....",
    "....ossssssso...",
    "....osskskkso...",
    "....ossssssso...",
    ".....ossssso....",
    "......bbbb......",
    "..s.bbbbbbbb.s..",
    "...sbbbbbbbbs...",
    "....bbbbbbbb....",
    "....bbbbbbbb....",
    "...ddd....ddd...",
    "..ddd......ddd..",
    "..kkk......kkk..",
    "................",
  ],
];
const palette: Record<string, number[]> = {
  ".": [0, 0, 0, 0],
  o: [249, 115, 22, 255],
  s: [255, 214, 170, 255],
  k: [20, 20, 30, 255],
  b: [59, 130, 246, 255],
  d: [40, 50, 90, 255],
};
const width = 32;
const height = 16;
const raw = new Uint8Array(height * (1 + width * 4));
for (let y = 0; y < height; y++) {
  raw[y * (1 + width * 4)] = 0;
  for (let x = 0; x < width; x++) {
    const frame = art[Math.floor(x / 16)];
    const color = palette[frame[y][x % 16]];
    raw.set(color, y * (1 + width * 4) + 1 + x * 4);
  }
}
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
};
const ihdr = new Uint8Array(13);
const ihdrView = new DataView(ihdr.buffer);
ihdrView.setUint32(0, width);
ihdrView.setUint32(4, height);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = new Uint8Array([
  ...[137, 80, 78, 71, 13, 10, 26, 10],
  ...chunk("IHDR", ihdr),
  ...chunk("IDAT", deflateSync(raw)),
  ...chunk("IEND", new Uint8Array(0)),
]);
await Bun.write(new URL("../assets/crafter.png", import.meta.url), png);
console.log(`assets/crafter.png ${png.length} bytes`);
