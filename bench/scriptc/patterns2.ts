// Second round: patterns still hot in dotframe's bench2d after the first round of workarounds.
const N = 50_000;
const FRAMES = 200;
const results: string[] = [];
const time = (label: string, fn: () => number): void => {
  fn();
  const start = performance.now();
  const check = fn();
  results.push(`${label.padEnd(60)} ${(performance.now() - start).toFixed(1).padStart(7)} ms  (${Math.round(check)})`);
};

// G: a game loop closure reading and writing captured `const` typed arrays (never reassigned).
const px = new Float32Array(N);
const py = new Float32Array(N);
const pvx = new Float32Array(N);
const pvy = new Float32Array(N);
for (let i = 0; i < N; i++) {
  px[i] = i % 960;
  py[i] = i % 540;
  pvx[i] = ((i % 7) - 3) * 0.5;
  pvy[i] = ((i % 5) - 2) * 0.5;
}
const stepCaptured = (): void => {
  for (let i = 0; i < N; i++) {
    px[i] += pvx[i];
    py[i] += pvy[i];
    if (px[i] < 0 || px[i] > 960) pvx[i] = -pvx[i];
    if (py[i] < 0 || py[i] > 540) pvy[i] = -pvy[i];
  }
};
time("G  captured const Float32Array, update loop in a closure", (): number => {
  for (let f = 0; f < FRAMES; f++) stepCaptured();
  return px[1];
});

// G': same loop with local aliases taken once per call.
const stepAliased = (): void => {
  const x = px;
  const y = py;
  const vx = pvx;
  const vy = pvy;
  for (let i = 0; i < N; i++) {
    x[i] += vx[i];
    y[i] += vy[i];
    if (x[i] < 0 || x[i] > 960) vx[i] = -vx[i];
    if (y[i] < 0 || y[i] > 540) vy[i] = -vy[i];
  }
};
time("G' same, local aliases of the captured arrays", (): number => {
  for (let f = 0; f < FRAMES; f++) stepAliased();
  return px[1];
});

// H: reading elements of a dense number[] (path points) versus a Float64Array.
const points: number[] = [];
for (let i = 0; i < 96; i++) points.push(i * 0.5);
const pointsTyped = new Float64Array(96);
for (let i = 0; i < 96; i++) pointsTyped[i] = i * 0.5;
time("H  read a 96-element number[] (one circle's points)", (): number => {
  let sum = 0;
  for (let shape = 0; shape < N * 4; shape++) for (let k = 0; k < 96; k++) sum += points[k];
  return sum;
});
time("H' same reads from a Float64Array", (): number => {
  let sum = 0;
  for (let shape = 0; shape < N * 4; shape++) for (let k = 0; k < 96; k++) sum += pointsTyped[k];
  return sum;
});

// I: optional element read and narrowing (`T | undefined`), as when checking the last batch.
interface Batch {
  texture: number;
  count: number;
}
const batches: Batch[] = [{ texture: 1, count: 0 }];
time("I  read last element as Batch | undefined, narrow, compare", (): number => {
  let hits = 0;
  for (let i = 0; i < N * 60; i++) {
    const last: Batch | undefined = batches[batches.length - 1];
    if (last && last.texture === 1) hits += 1;
  }
  return hits;
});

for (const line of results) console.log(line);
