// Second round: patterns still hot in dotframe's bench2d after the first round of workarounds.
const N = 50_000;
const FRAMES = 200;

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
const end = performance.now() + 5000;
let frames = 0;
while (performance.now() < end) {
  stepCaptured();
  frames += 1;
}
console.log(frames, px[1]);
