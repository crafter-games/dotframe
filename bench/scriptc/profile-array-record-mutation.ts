interface Batch { texture: number; count: number }
const batches: Batch[] = [{ texture: 1, count: 0 }];
const end = performance.now() + 5000;
let sink = 0;
while (performance.now() < end) {
  for (let i = 0; i < 1000000; i++) {
    const last = batches[batches.length - 1];
    if (last.texture === 1) last.count += 6;
  }
}
console.log(sink + batches[0].count);
