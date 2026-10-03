import { createDraw2D } from "../../src/draw2d";
import type { Frame, Setup, Texture } from "../../src/gpu";
import type { Platform } from "../../src/platform";

// 2D throughput benchmark: N moving animated sprites, N/4 circles and 20 text lines per frame.
// bench/canvas2d.html draws the same scene with the browser's Canvas2D for comparison.

export const windowOptions = { width: 960, height: 540, title: "dotframe: bench2d" };
export const stages = [1000, 5000, 10000, 20000, 50000];
const WARMUP = 1;
const MEASURE = 3;

export interface BenchAssets {
  sprite: Uint8Array;
  fontAtlas: Uint8Array;
  fontMetrics: Uint8Array;
}

export interface StageResult {
  sprites: number;
  frames: number;
  // Mean wall time between frames and mean CPU time spent building and submitting one frame, in ms.
  frameMs: number;
  cpuMs: number;
  p95CpuMs: number;
  // Part of cpuMs spent building the frame (game update and draw calls), before submitting it.
  buildMs: number;
}

export function createSetup(
  assets: BenchAssets,
  report: (result: StageResult) => void,
  now: () => number,
  onFirstFrame: () => void,
): Setup {
  return ({ gpu }: Platform): Frame => {
    const ctx = createDraw2D(gpu, windowOptions.width, windowOptions.height);
    let sprite: Texture | null = null;
    gpu.createImage(assets.sprite, false).then((texture: Texture): void => {
      sprite = texture;
    });
    gpu.createImage(assets.fontAtlas, true).then((atlas: Texture): void => {
      ctx.addFont(["Bangers"], atlas, new TextDecoder().decode(assets.fontMetrics));
    });

    const max = stages[stages.length - 1];
    const x = new Float32Array(max);
    const y = new Float32Array(max);
    const vx = new Float32Array(max);
    const vy = new Float32Array(max);
    let seed = 1;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < max; i++) {
      x[i] = random() * windowOptions.width;
      y[i] = random() * windowOptions.height;
      vx[i] = (random() - 0.5) * 4;
      vy[i] = (random() - 0.5) * 4;
    }

    let stage = 0;
    let stageStart = -1;
    let lastTime = -1;
    let cpuSamples: number[] = [];
    let wallSamples: number[] = [];
    let buildSamples: number[] = [];

    return (time: number): boolean => {
      const current = sprite;
      if (!current) return true;
      if (stageStart < 0) {
        stageStart = time;
        onFirstFrame();
      }
      const count = stages[stage];
      const begin = now();

      for (let i = 0; i < count; i++) {
        x[i] += vx[i];
        y[i] += vy[i];
        if (x[i] < 0 || x[i] > windowOptions.width) vx[i] = -vx[i];
        if (y[i] < 0 || y[i] > windowOptions.height) vy[i] = -vy[i];
      }

      ctx.begin();
      const frameIndex = Math.floor(time * 6) % 2;
      for (let i = 0; i < count; i++) ctx.drawImage(current, frameIndex * 16, 0, 16, 16, x[i] - 16, y[i] - 16, 32, 32);
      ctx.setFillStyle("rgba(249, 115, 22, 0.5)");
      for (let i = 0; i < count / 4; i++) {
        ctx.beginPath();
        ctx.arc(x[i], y[i], 6, 0, Math.PI * 2, false);
        ctx.fill();
      }
      ctx.setFont("20px Bangers");
      ctx.setTextAlign("left");
      ctx.setTextBaseline("top");
      ctx.setFillStyle("#ffffff");
      for (let line = 0; line < 20; line++) ctx.fillText(`${count} sprites line ${line}`, 10, 10 + line * 24);
      const built = now();
      ctx.end({ r: 0.06, g: 0.06, b: 0.1 });

      const elapsed = time - stageStart;
      if (elapsed >= WARMUP) {
        cpuSamples.push(now() - begin);
        buildSamples.push(built - begin);
        if (lastTime >= 0) wallSamples.push((time - lastTime) * 1000);
      }
      lastTime = time;

      if (elapsed >= WARMUP + MEASURE) {
        const sorted = cpuSamples.slice().sort((a: number, b: number): number => a - b);
        const mean = (values: number[]): number => values.reduce((sum: number, v: number): number => sum + v, 0) / Math.max(values.length, 1);
        report({
          sprites: count,
          frames: cpuSamples.length,
          frameMs: mean(wallSamples),
          cpuMs: mean(cpuSamples),
          p95CpuMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          buildMs: mean(buildSamples),
        });
        stage++;
        stageStart = time;
        cpuSamples = [];
        wallSamples = [];
        buildSamples = [];
        if (stage >= stages.length) return false;
      }
      return true;
    };
  };
}
