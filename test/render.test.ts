import { expect, test } from "bun:test";
import { createDraw2D } from "../src/draw2d";
import { createWorld, spawn } from "../src/ecs";
import type { Color, Draw, PipelineOptions, RenderGpu, Texture } from "../src/gpu";
import { vec3 } from "../src/math";
import { createRenderer, MAX_LIGHTS } from "../src/render";
import { box } from "../src/shapes";

// Records pipelines, uniform writes and frames instead of drawing.
function recordingGpu() {
  const pipelines: PipelineOptions[] = [];
  const writes: Float32Array[] = [];
  const frames: { clear: Color; draws: Draw[] }[] = [];
  let buffers = 0;
  let textures = 0;
  const gpu: RenderGpu = {
    createBuffer: (): number => buffers++,
    writeBuffer: (_b: number, data: Uint8Array): void => {
      writes.push(new Float32Array(data.slice().buffer));
    },
    destroyBuffer: (): void => {},
    createPipeline: (options: PipelineOptions): number => pipelines.push(options) - 1,
    bind: (): number => 0,
    createTexture: (width: number, height: number): Texture => ({ id: textures++, width, height }),
    frame: (clear: Color, draws: Draw[]): void => {
      frames.push({ clear, draws });
    },
    aspect: (): number => 16 / 9,
  };
  return { gpu, pipelines, writes, frames };
}

function oneBoxWorld() {
  const world = createWorld();
  const entity = spawn(world);
  world.transforms.set(entity, { position: vec3(0, 0, -5), rotation: vec3(0, 0, 0), scale: vec3(1, 1, 1) });
  return { world, entity };
}

test("draws() returns the scene's draws without presenting a frame", () => {
  const { gpu, frames } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 0, 0) });
  const draws = renderer.draws(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 });
  expect(draws.length).toBe(1);
  expect(draws[0].count).toBe(36);
  expect(frames.length).toBe(0);
  renderer.render(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 }, { r: 0, g: 0, b: 0 });
  expect(frames.length).toBe(1);
});

test("Draw2D.scene() puts 3D draws before the 2D batch in one frame", () => {
  const { gpu, pipelines, frames } = recordingGpu();
  const renderer = createRenderer(gpu);
  const draw = createDraw2D(gpu, 320, 180);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1) });
  draw.begin();
  draw.scene(renderer.draws(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 }));
  draw.setFillStyle("#ffffff");
  draw.fillRect(0, 0, 10, 10);
  draw.end({ r: 0.1, g: 0.2, b: 0.3 });
  expect(frames.length).toBe(1);
  const kinds = frames[0].draws.map((d: Draw): boolean => pipelines[d.pipeline].depth);
  expect(kinds).toEqual([true, false]);
  // The queue is per frame: the next frame starts empty.
  draw.begin();
  draw.end({ r: 0, g: 0, b: 0 });
  expect(frames[1].draws.length).toBe(0);
});

test("the environment reaches the uniforms: emissive, texture tile, lights, spot and exposure", () => {
  const { gpu, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  const texture: Texture = { id: 42, width: 4, height: 4 };
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(0.5, 0.5, 0.5), texture, tile: 3, emissive: 2 });
  const lights = Array.from({ length: MAX_LIGHTS + 2 }, (_: unknown, i: number) => ({ position: vec3(i, 1, 0), color: vec3(1, 1, 1), range: 5 + i }));
  renderer.draws(world, { eye: vec3(0, 2, 0), target: vec3(0, 0, -1), fovY: 1 }, {
    ambient: vec3(0.1, 0.2, 0.3),
    fog: { color: vec3(0.05, 0.06, 0.07), density: 0.02 },
    lights,
    spot: { position: vec3(0, 2, 0), direction: vec3(0, 0, -1), color: vec3(1, 1, 1), range: 22, angle: 0.4 },
    exposure: 1.5,
  });
  const u = writes[writes.length - 1];
  // color.w is emissive; material is (tile, textured).
  expect(u[35]).toBe(2);
  expect([u[36], u[37]]).toEqual([3, 1]);
  // eye.w carries the exposure; fog.w the density.
  expect(u[43]).toBeCloseTo(1.5, 5);
  expect(u[47]).toBeCloseTo(0.02, 5);
  // Spot range and the cosine of its half angle.
  expect(u[40 + 5 * 4 + 3]).toBe(22);
  expect(u[40 + 6 * 4 + 3]).toBeCloseTo(Math.cos(0.4), 5);
  // Lights past MAX_LIGHTS are dropped: the last slot holds light MAX_LIGHTS - 1.
  expect(u.length).toBe(40 + 8 * 4 + MAX_LIGHTS * 8);
  expect(u[40 + (8 + (MAX_LIGHTS - 1) * 2) * 4 + 3]).toBe(5 + MAX_LIGHTS - 1);
});

test("an untextured mesh binds the white pixel and keeps the default key light", () => {
  const { gpu, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1) });
  renderer.draws(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 });
  const u = writes[writes.length - 1];
  expect(u[37]).toBe(0);
  expect(u[43]).toBe(0);
  expect([u[48], u[49], u[50]]).toEqual([0.25, 0.25, 0.25].map((v) => Math.fround(v)));
});

test("box() is side 1, from -0.5 to 0.5", () => {
  const p = box().positions;
  expect(Math.min(...p)).toBe(-0.5);
  expect(Math.max(...p)).toBe(0.5);
});
