import { expect, test } from "bun:test";
import { createDraw2D } from "../src/draw2d";
import { createWorld, spawn } from "../src/ecs";
import type { Color, Draw, PipelineOptions, RenderGpu, Texture } from "../src/gpu";
import { lookAt, multiply, perspective, vec3 } from "../src/math";
import { createRenderer, INSTANCE_FLOATS, MAX_FOG_VOLUMES, MAX_LIGHTS, MAX_SPOTS, pickLights } from "../src/render";
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

test("a mesh off layer 1 shows only to a camera on its layer and casts no shadow", () => {
  const { gpu, frames } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 0, 0), layers: 2 });
  const eye = { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 };
  expect(renderer.draws(world, eye).length).toBe(0);
  expect(renderer.draws(world, { ...eye, layers: 1 | 2 }).length).toBe(1);
  renderer.draws(world, { ...eye, layers: 3 }, { ambient: vec3(0, 0, 0), sun: { direction: vec3(0, 1, 0), color: vec3(1, 1, 1), shadows: 50 } });
  expect(frames.every((f) => f.draws.length === 0)).toBe(true);
});

test("Camera.roll turns the view about its direction", () => {
  const { gpu, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 0, 0) });
  const mvp = (roll: number): number[] => {
    renderer.draws(world, { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1, aspect: 1, roll });
    return Array.from(writes[writes.length - 1].slice(0, 16));
  };
  const flat = mvp(0);
  const turned = mvp(Math.PI / 2);
  // A quarter turn swaps the x and y rows of the projection (up to sign), and the image is no longer the same.
  expect(turned).not.toEqual(flat);
  expect(Math.abs(turned[0])).toBeCloseTo(Math.abs(flat[1]), 5);
  expect(Math.abs(turned[1])).toBeCloseTo(Math.abs(flat[0]), 5);
});

test("two worlds drawn by one renderer keep their own entity buffers", () => {
  const { gpu } = recordingGpu();
  let created = 0;
  const make = gpu.createBuffer;
  gpu.createBuffer = (usage: number, data: Uint8Array): number => {
    created++;
    return make(usage, data);
  };
  const renderer = createRenderer(gpu);
  const a = oneBoxWorld();
  const b = oneBoxWorld();
  const mesh = renderer.addMesh(box());
  a.world.meshes.set(a.entity, { mesh, color: vec3(1, 0, 0) });
  b.world.meshes.set(b.entity, { mesh, color: vec3(0, 1, 0) });
  const camera = { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 };
  renderer.draws(a.world, camera);
  const afterA = created;
  renderer.draws(b.world, camera);
  expect(a.entity).toBe(b.entity);
  // The second world's entity gets its own uniform buffer instead of rewriting the first one's.
  expect(created).toBe(afterA + 1);
});

test("updateInstances rewrites a set in place and keeps its count", () => {
  const { gpu, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const data = new Float32Array(INSTANCE_FLOATS * 3);
  for (let i = 0; i < 3; i++) data.set([i * 20, 0, 0, 1], i * INSTANCE_FLOATS);
  const set = renderer.addInstances(data);
  const before = writes.length;
  data[0] = 5;
  renderer.updateInstances(set, data);
  expect(writes.length).toBe(before + 1);
  expect(set.count).toBe(3);
  expect(Array.from(writes[writes.length - 1]).includes(5)).toBe(true);
  expect(() => renderer.updateInstances(set, new Float32Array(INSTANCE_FLOATS))).toThrow();
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
  expect(u.length).toBe(40 + 8 * 4 + MAX_LIGHTS * 8 + 40 + MAX_LIGHTS * 8 + (MAX_SPOTS - 1) * 12 + 4 + MAX_FOG_VOLUMES * 8 + 8);
  expect(u[40 + (8 + (MAX_LIGHTS - 1) * 2) * 4 + 3]).toBe(5 + MAX_LIGHTS - 1);
});

test("pickLights drops unlit and out-of-view lights, then keeps the nearest MAX_LIGHTS in order", () => {
  const eye = vec3(0, 1, 0);
  const vp = multiply(perspective(1, 1, 0.1, 200), lookAt(eye, vec3(0, 1, -1), vec3(0, 1, 0)));
  const at = (z: number, range = 2) => ({ position: vec3(0, 1, z), color: vec3(1, 1, 1), range });
  const behind = at(30);
  const dark = { ...at(-3), color: vec3(0, 0, 0) };
  const far = Array.from({ length: MAX_LIGHTS }, (_: unknown, i: number) => at(-40 - i * 5));
  const near = [at(-4), at(-6)];
  const picked = pickLights([behind, dark, ...far, ...near], vp, eye);
  expect(picked.length).toBe(MAX_LIGHTS);
  expect(picked).not.toContain(behind);
  expect(picked).not.toContain(dark);
  // The two near ones win over the farthest two; the order handed in is kept.
  expect(picked.slice(-2)).toEqual(near);
  expect(picked.slice(0, MAX_LIGHTS - 2)).toEqual(far.slice(0, MAX_LIGHTS - 2));
});

test("a sun with shadows draws casters into the right half of the map, and light boxes reach the uniforms", () => {
  const { gpu, writes, frames } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1) });
  const lights = [{ position: vec3(0, 2, 0), color: vec3(1, 1, 1), range: 5, box: { min: vec3(-1, 0, -1), max: vec3(1, 3, 1), outside: true } }];
  renderer.draws(world, { eye: vec3(0, 2, 5), target: vec3(0, 0, 0), fovY: 1 }, { ambient: vec3(0, 0, 0), sun: { direction: vec3(0.3, 1, 0.2), color: vec3(1, 1, 1), shadows: 60 }, lights });
  // One shadow frame with the box as its caster, before the scene.
  expect(frames.length).toBe(1);
  expect(frames[0].draws.length).toBe(1);
  const caster = writes[0];
  // color.x = 1 marks the sun's half; the box at the origin lands in x > 0 of the map's clip space.
  expect(caster[32]).toBe(1);
  expect(caster[12]).toBeGreaterThan(0);
  const u = writes[writes.length - 1];
  const sun = 40 + 8 * 4 + MAX_LIGHTS * 8 + 20;
  expect(u[sun + 16]).toBe(1);
  const boxes = sun + 20;
  expect([u[boxes], u[boxes + 3], u[boxes + 4], u[boxes + 5]]).toEqual([-1, 2, 1, 3]);
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
  // All three sit in one ground cell, drawn as the range of that cell.
  expect(instances.cells).toHaveLength(1);
  expect([draw.instanceBuffer, draw.instances, draw.firstInstance]).toEqual([instances.buffer, 3, 0]);
  expect(pipelines[draw.pipeline].instanceStride).toBe(INSTANCE_FLOATS * 4);
  expect(pipelines[draw.pipeline].instanceAttributes?.map((a) => a.location)).toEqual([3, 4]);
  const u = writes[writes.length - 1];
  // material.w is the sway; sunDir.w the time, with no sun set.
  expect(u[39]).toBeCloseTo(0.06, 5);
  expect(u[40 + 3 * 4 + 3]).toBe(2.5);
});

test("instance cells outside the view are skipped, and on mobile far cells draw a prefix", () => {
  // 100 small instances in a cell 2 m ahead and 100 in a cell 200 m ahead, plus 100 behind the camera.
  const data: number[] = [];
  for (const z of [-2, -200, 120]) for (let i = 0; i < 100; i++) data.push((i % 10) * 0.1, 0, z - Math.floor(i / 10) * 0.1, 1, 0, 0, 0, 0);
  const camera = { eye: vec3(0, 1, 0), target: vec3(0, 1, -10), fovY: 1, far: 500 };
  const counts = (mobile: boolean): number[] => {
    const { gpu } = recordingGpu();
    const renderer = createRenderer({ ...gpu, mobile });
    const { world, entity } = oneBoxWorld();
    world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1), instances: renderer.addInstances(new Float32Array(data)) });
    return renderer.draws(world, camera).map((d: Draw): number => d.instances ?? 1).sort((a: number, b: number): number => b - a);
  };
  expect(counts(false)).toEqual([100, 100]);
  // The box's radius is 0.87 m: full density at 2 m, the floor (8 of 100) at 200 m.
  expect(counts(true)).toEqual([100, 8]);
});

test("every renderer shader is fully interpolated (bun cannot compile WGSL, but it can catch a literal ${)", () => {
  const { gpu, pipelines } = recordingGpu();
  const renderer = createRenderer(gpu);
  renderer.addInstances(new Float32Array(INSTANCE_FLOATS));
  renderer.addSkinnedMesh(box(), { positions: new Float32Array(72), normals: new Float32Array(72), joints: new Float32Array(96), weights: new Float32Array(96) });
  expect(pipelines.length).toBe(4);
  for (const p of pipelines) expect(p.wgsl).not.toContain("${");
});

test("a custom material draws on its own pipeline with its params, and leaves built-in meshes untouched", () => {
  const plain = recordingGpu();
  const before = createRenderer(plain.gpu);
  const one = oneBoxWorld();
  one.world.meshes.set(one.entity, { mesh: before.addMesh(box()), color: vec3(1, 0, 0) });
  const camera = { eye: vec3(0, 0, 0), target: vec3(0, 0, -1), fovY: 1 };
  const plainDraws = before.draws(one.world, camera);
  const plainUniforms = Array.from(plain.writes[plain.writes.length - 1]);

  const { gpu, pipelines, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const skin = renderer.createMaterial("fn surface(s: SurfaceIn) -> Surface { return Surface(vec3f(s.params0.x), vec3f(0.0)); }");
  const { world, entity } = oneBoxWorld();
  const mesh = renderer.addMesh(box());
  world.meshes.set(entity, { mesh, color: vec3(1, 0, 0) });
  // Same scene, same pipelines and uniforms as a renderer that never saw a material.
  expect(renderer.draws(world, camera)).toEqual(plainDraws);
  expect(Array.from(writes[writes.length - 1])).toEqual(plainUniforms);
  expect(pipelines[0].wgsl).toBe(plain.pipelines[0].wgsl);

  world.meshes.set(entity, { mesh, color: vec3(1, 0, 0), material: skin, params: [0.46, 0.5, 0, 0, 1, 2, 3, 4] });
  const draws = renderer.draws(world, camera);
  const custom = pipelines[draws[0].pipeline];
  expect(draws[0].pipeline).not.toBe(plainDraws[0].pipeline);
  expect(custom.wgsl).toContain("fn surface(s: SurfaceIn)");
  expect(custom.wgsl).not.toContain("${");
  const u = writes[writes.length - 1];
  const at = u.length - 8;
  expect(Array.from(u.slice(at, at + 8)).map((v) => Math.round(v * 100) / 100)).toEqual([0.46, 0.5, 0, 0, 1, 2, 3, 4]);
  // One pipeline per material and kind, made once.
  const count = pipelines.length;
  renderer.draws(world, camera);
  expect(pipelines.length).toBe(count);
});

test("several spot lights: the shadowed one takes the main slot, the rest light without shadows, past MAX_SPOTS dropped", () => {
  const { gpu, writes, frames } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  world.meshes.set(entity, { mesh: renderer.addMesh(box()), color: vec3(1, 1, 1) });
  const spot = (range: number, shadows: boolean) => ({ position: vec3(0, 2, 0), direction: vec3(0, 0, -1), color: vec3(1, 1, 1), range, angle: 0.4, shadows });
  renderer.draws(world, { eye: vec3(0, 2, 0), target: vec3(0, 0, -1), fovY: 1 }, {
    ambient: vec3(0, 0, 0),
    spot: spot(16, false),
    spots: [spot(22, true), ...Array.from({ length: MAX_SPOTS }, (_: unknown, i: number) => spot(30 + i, false))],
  });
  const u = writes[writes.length - 1];
  // The flashlight (shadows) in the main slot; the IR next; then as many as fit.
  expect(u[40 + 5 * 4 + 3]).toBe(22);
  const extra = 40 + 8 * 4 + MAX_LIGHTS * 8 + 40 + MAX_LIGHTS * 8;
  expect(u[extra + 3]).toBe(16);
  expect(u[extra + 12 + 3]).toBe(30);
  expect(u[extra + (MAX_SPOTS - 2) * 12 + 3]).toBe(30 + MAX_SPOTS - 3);
  // One shadow map pass, for the shadowed spot only.
  expect(frames.length).toBe(1);
});

test("fog scattering and fog volumes reach the uniforms, and a mesh with fog off gets none of them", () => {
  const { gpu, writes } = recordingGpu();
  const renderer = createRenderer(gpu);
  const { world, entity } = oneBoxWorld();
  const mesh = renderer.addMesh(box());
  world.meshes.set(entity, { mesh, color: vec3(1, 1, 1) });
  const camera = { eye: vec3(0, 1, 0), target: vec3(0, 1, -1), fovY: 1 };
  const env = {
    ambient: vec3(0, 0, 0),
    fog: { color: vec3(0.5, 0.5, 0.5), density: 0.02, scatter: 0.6, volumes: [{ min: vec3(-40, -0.4, -46), max: vec3(40, 1.2, 34), density: 0.1, falloff: 1.2 }] },
    lights: [{ position: vec3(0, 1.25, -8), color: vec3(1, 1, 1), range: 9, fog: 2.6 }],
  };
  renderer.draws(world, camera, env);
  const u = writes[writes.length - 1];
  const at = 40 + 8 * 4 + MAX_LIGHTS * 8 + 40 + MAX_LIGHTS * 8 + (MAX_SPOTS - 1) * 12;
  expect(u[at]).toBeCloseTo(0.6, 5);
  expect(u[at + 1]).toBe(1);
  expect(Array.from(u.slice(at + 4, at + 12)).map((v) => Math.round(v * 100) / 100)).toEqual([-40, -0.4, -46, 0.1, 40, 1.2, 34, 1.2]);
  // A light's fog energy rides in its color's w.
  expect(u[40 + 9 * 4 + 3]).toBeCloseTo(2.6, 5);
  world.meshes.set(entity, { mesh, color: vec3(1, 1, 1), fog: false });
  renderer.draws(world, camera, env);
  const off = writes[writes.length - 1];
  expect([off[47], off[at], off[at + 1]]).toEqual([0, 0, 0]);
});
