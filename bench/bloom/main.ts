// The dotframe bench2d scene on Bloom: N moving animated sprites (32x32 from a 16x16 sheet), N/4 alpha circles
// and 20 text lines per frame. Same stages, warmup and measurement windows as dotframe's examples/bench2d.
import { beginDrawing, clearBackground, endDrawing, getTime, initWindow, setDirect2DMode, setTargetFPS, windowShouldClose } from "@bloomengine/engine/core";
import { drawCircle } from "@bloomengine/engine/shapes";
import { drawTextRgba } from "@bloomengine/engine/text";
import { drawTextureProRaw, loadTexture } from "@bloomengine/engine/textures";

const W = 960;
const H = 540;
const stages = [1000, 5000, 10000, 20000, 50000];
const WARMUP = 1;
const MEASURE = 3;
const start = Date.now();

initWindow(W, H, "bloom: bench2d");
setDirect2DMode(true);
setTargetFPS(Number(process.env.FPS ?? "0"));
const sprite = loadTexture("crafter.png");

const max = stages[stages.length - 1];
const x: number[] = [];
const y: number[] = [];
const vx: number[] = [];
const vy: number[] = [];
let seed = 1;
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
for (let i = 0; i < max; i++) {
  x.push(random() * W);
  y.push(random() * H);
  vx.push((random() - 0.5) * 4);
  vy.push((random() - 0.5) * 4);
}
const orange = { r: 249, g: 115, b: 22, a: 128 };
const white = { r: 255, g: 255, b: 255, a: 255 };
const bg = { r: 15, g: 15, b: 26, a: 255 };

let stage = 0;
let stageStart = -1;
let lastTime = -1;
let cpu: number[] = [];
let wall: number[] = [];
let build: number[] = [];
const mean = (v: number[]): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return v.length > 0 ? s / v.length : 0;
};

while (!windowShouldClose() && stage < stages.length) {
  const time = getTime();
  if (stageStart < 0) {
    stageStart = time;
    console.log(JSON.stringify({ firstFrameMs: Date.now() - start }));
  }
  const count = stages[stage];
  const begin = getTime();
  for (let i = 0; i < count; i++) {
    x[i] += vx[i];
    y[i] += vy[i];
    if (x[i] < 0 || x[i] > W) vx[i] = -vx[i];
    if (y[i] < 0 || y[i] > H) vy[i] = -vy[i];
  }
  beginDrawing();
  clearBackground(bg);
  const frameIndex = Math.floor(time * 6) % 2;
  for (let i = 0; i < count; i++) drawTextureProRaw(sprite.handle, frameIndex * 16, 0, 16, 16, x[i] - 16, y[i] - 16, 32, 32, 0, 0, 0, 255, 255, 255, 255);
  for (let i = 0; i < count / 4; i++) drawCircle(x[i], y[i], 6, orange);
  for (let line = 0; line < 20; line++) drawTextRgba(`${count} sprites line ${line}`, 10, 10 + line * 24, 20, 255, 255, 255, 255);
  const built = getTime();
  endDrawing();
  const done = getTime();
  const elapsed = time - stageStart;
  if (elapsed >= WARMUP) {
    cpu.push((done - begin) * 1000);
    build.push((built - begin) * 1000);
    if (lastTime >= 0) wall.push((time - lastTime) * 1000);
  }
  lastTime = time;
  if (elapsed >= WARMUP + MEASURE) {
    console.log(JSON.stringify({ sprites: count, frames: cpu.length, frameMs: mean(wall), cpuMs: mean(cpu), buildMs: mean(build) }));
    stage += 1;
    stageStart = time;
    cpu = [];
    wall = [];
    build = [];
  }
}
