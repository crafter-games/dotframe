// Patterns from dotframe's 2D vertex writer. Each case writes VERTS vertices of 9 floats.
const VERTS = 3_000_000;
const FLOATS = 9;
const results: string[] = [];
const time = (label: string, fn: () => number): void => {
  fn();
  const start = performance.now();
  const check = fn();
  results.push(`${label.padEnd(58)} ${(performance.now() - start).toFixed(1).padStart(7)} ms  (${check})`);
};

// A: captured `let` typed array (reassigned elsewhere, as when a buffer grows), written 9 times per call.
let grown = new Float32Array(VERTS * FLOATS);
let countA = 0;
const writeA = (x: number, y: number): void => {
  const o = countA * FLOATS;
  grown[o] = x; grown[o + 1] = y; grown[o + 2] = 0; grown[o + 3] = 0; grown[o + 4] = 1;
  grown[o + 5] = 1; grown[o + 6] = 1; grown[o + 7] = 1; grown[o + 8] = -1;
  countA = countA + 1;
};
time("A  captured let array, 9 writes per closure call", (): number => {
  countA = 0;
  for (let i = 0; i < VERTS; i++) writeA(i, i);
  return grown[9];
});

// B: same, with a local alias taken once per call.
const writeB = (x: number, y: number): void => {
  const out = grown;
  const o = countA * FLOATS;
  out[o] = x; out[o + 1] = y; out[o + 2] = 0; out[o + 3] = 0; out[o + 4] = 1;
  out[o + 5] = 1; out[o + 6] = 1; out[o + 7] = 1; out[o + 8] = -1;
  countA = countA + 1;
};
time("B  same, local alias of the captured array", (): number => {
  countA = 0;
  for (let i = 0; i < VERTS; i++) writeB(i, i);
  return grown[9];
});

// C: inline loop, no closure call per vertex, alias hoisted out of the loop.
time("C  inline loop, alias hoisted", (): number => {
  const out = grown;
  let o = 0;
  for (let i = 0; i < VERTS; i++) {
    out[o] = i; out[o + 1] = i; out[o + 2] = 0; out[o + 3] = 0; out[o + 4] = 1;
    out[o + 5] = 1; out[o + 6] = 1; out[o + 7] = 1; out[o + 8] = -1;
    o += FLOATS;
  }
  return out[9];
});

// D: reading 6 fields of a captured `let` record per call (the 2D transform state).
interface Transform { a: number; b: number; c: number; d: number; e: number; f: number }
let transform: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const project = (x: number, y: number): number =>
  transform.a * x + transform.c * y + transform.e + transform.b * x + transform.d * y + transform.f;
time("D  6 reads of a captured let record per call", (): number => {
  let sum = 0;
  for (let i = 0; i < VERTS; i++) sum += project(i, 1);
  return sum;
});
const projectAliased = (x: number, y: number): number => {
  const t = transform;
  return t.a * x + t.c * y + t.e + t.b * x + t.d * y + t.f;
};
time("D' same, local alias of the record", (): number => {
  let sum = 0;
  for (let i = 0; i < VERTS; i++) sum += projectAliased(i, 1);
  return sum;
});

// E: building a polygon with push() into a fresh number[] per shape (12 points), vs reusing one array.
time("E  fresh number[] + push per shape (12 points)", (): number => {
  let total = 0;
  for (let i = 0; i < VERTS / 12; i++) {
    const points: number[] = [];
    for (let k = 0; k < 12; k++) points.push(k, i);
    total += points.length;
  }
  return total;
});
const pooled: number[] = [];
time("E' reused number[] (length = 0) per shape", (): number => {
  let total = 0;
  for (let i = 0; i < VERTS / 12; i++) {
    pooled.length = 0;
    for (let k = 0; k < 12; k++) pooled.push(k, i);
    total += pooled.length;
  }
  return total;
});

// F: mutating the last record of an array of records (batching).
interface Batch { texture: number; count: number }
const batches: Batch[] = [{ texture: 1, count: 0 }];
time("F  read last array element (record) and mutate a field", (): number => {
  for (let i = 0; i < VERTS; i++) {
    const last = batches[batches.length - 1];
    if (last.texture === 1) last.count += 6;
  }
  return batches[0].count;
});

for (const line of results) console.log(line);
