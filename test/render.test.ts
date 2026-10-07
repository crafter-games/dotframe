import { expect, test } from "bun:test";
import { createDraw2D } from "../src/draw2d";
import { createWorld, spawn } from "../src/ecs";
import type { Color, Draw, PipelineOptions, RenderGpu, Texture } from "../src/gpu";
import { vec3 } from "../src/math";
import { createRenderer, INSTANCE_FLOATS, MAX_LIGHTS } from "../src/render";
import { createPostPass, POST_PARAMS } from "../src/post";
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
    createTarget: (width: number, height: number): Texture => ({ id: textures++, width, height }),
    destroyTexture: (): void => {},
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
  expect(u.length).toBe(40 + 8 * 4 + MAX_LIGHTS * 8 + 20);
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

test("a post pass renders into a target it recreates only on resize, and draws one full-screen triangle", () => {
  const { gpu, pipelines } = recordingGpu();
  const made: Texture[] = [];
  const destroyed: number[] = [];
  gpu.createTarget = (width: number, height: number): Texture => {
    const t = { id: 100 + made.length, width, height };
    made.push(t);
    return t;
  };
  gpu.destroyTexture = (t: Texture): void => {
    destroyed.push(t.id);
  };
  const post = createPostPass(gpu, "fn post(uv: vec2f, pixel: vec2f) -> vec4f { return textureSample(src, samp, uv) * u.params[0]; }");
  expect(post.target()).toBeUndefined();
  post.resize(1280, 720);
  post.resize(1280, 720);
  expect(made.length).toBe(1);
  post.resize(960, 720);
  expect(made.length).toBe(2);
  expect(destroyed).toEqual([100]);
  expect(post.target()).toEqual({ id: 101, width: 960, height: 720 });
  const draw = post.draw(new Float32Array(POST_PARAMS));
  expect([draw.vertexBuffer, draw.indexBuffer, draw.count]).toEqual([-1, -1, 3]);
  expect(pipelines[draw.pipeline].depth).toBe(false);
  expect(pipelines[draw.pipeline].wgsl).toContain("fn post(uv: vec2f");
});

test("instanced meshes draw once with an instance buffer, count and sway, on a pipeline with instance attributes", () => {
  const { gpu, pipelines, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  const instances = renderer.addInstances(new Float32Array(INSTANCE_FLOATS * 3));
  expect(instances.count).toBe(3);
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1), instances, sway: 0.06 });
  const [draw] = renderer.draws(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 }, { ambient: vec3(0, 0, 0), time: 2.5 });
  expect([draw.instanceBuffer, draw.instances]).toEqual([instances.buffer, 3]);
  expect(pipelines[draw.pipeline].instanceStride).toBe(INSTANCE_FLOATS * 4);
  expect(pipelines[draw.pipeline].instanceAttributes?.map((a) => a.location)).toEqual([3, 4]);
  const u = writes[writes.length - 1];
  // material.w is the sway; sunDir.w the time, with no sun set.
  expect(u[39]).toBeCloseTo(0.06, 5);
  expect(u[40 + 3 * 4 + 3]).toBe(2.5);
});

test("every renderer shader is fully interpolated (bun cannot compile WGSL, but it can catch a literal ${)", () => {
  const { gpu, pipelines } = recordingGpu();
  const renderer = createRenderer(gpu);
  renderer.addInstances(new Float32Array(INSTANCE_FLOATS));
  renderer.addSkinnedMesh(box(), { positions: new Float32Array(72), normals: new Float32Array(72), joints: new Float32Array(96), weights: new Float32Array(96) });
  expect(pipelines.length).toBe(4);
  for (const p of pipelines) expect(p.wgsl).not.toContain("${");
});
