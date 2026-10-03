// Second round: patterns still hot in dotframe's bench2d after the first round of workarounds.
const N = 50_000;
const FRAMES = 200;

// I: optional element read and narrowing (`T | undefined`), as when checking the last batch.
interface Batch {
  texture: number;
  count: number;
}
const batches: Batch[] = [{ texture: 1, count: 0 }];
const end = performance.now() + 5000;
let hits = 0;
while (performance.now() < end) {
  for (let k = 0; k < 100000; k++) {
    const last: Batch | undefined = batches[batches.length - 1];
    if (last && last.texture === 1) hits += 1;
  }
}
console.log(hits);
