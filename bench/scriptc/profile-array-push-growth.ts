const end = performance.now() + 5000;
let sink = 0;
while (performance.now() < end) {
  for (let i = 0; i < 1000000; i++) {
    const points: number[] = [];
    for (let k = 0; k < 12; k++) points.push(k, i);
    sink += points.length;
  }
}
console.log(sink);
