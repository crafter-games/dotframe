interface Transform { a: number; b: number; c: number; d: number; e: number; f: number }
let transform: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const project = (x: number, y: number): number => transform.a * x + transform.c * y + transform.e + transform.b * x + transform.d * y + transform.f;
const end = performance.now() + 5000;
let sink = 0;
while (performance.now() < end) {
  for (let i = 0; i < 1000000; i++) {
    sink += project(i, 1);
  }
}
console.log(sink);
