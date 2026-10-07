import type { World } from "./ecs";
import type { MeshData } from "./gltf";
import { BufferUsage, type Color, type Draw, f32Bytes, type RenderGpu, type Texture, u32Bytes, VertexFormat } from "./gpu";
import { compose, lookAt, multiply, perspective, type Vec3, vec3 } from "./math";

export interface Camera {
  eye: Vec3;
  target: Vec3;
  fovY: number;
  // Clip planes; default 0.1 and 100.
  near?: number;
  far?: number;
}

export interface PointLight {
  position: Vec3;
  color: Vec3;
  // Distance where the light reaches zero.
  range: number;
}

export interface SpotLight extends PointLight {
  direction: Vec3;
  // Half angle of the cone, in radians.
  angle: number;
}

// Lighting for one frame. Leaving it out keeps the default: a fixed key light and no fog.
export interface Environment {
  ambient: Vec3;
  // Direction the light comes from (towards the light).
  sun?: { direction: Vec3; color: Vec3 };
  fog?: { color: Vec3; density: number };
  // At most MAX_LIGHTS; extra lights are ignored.
  lights?: PointLight[];
  spot?: SpotLight;
  // Turns on ACES filmic tonemapping at this exposure, so bright lights roll off instead of clipping to white.
  exposure?: number;
}

export const MAX_LIGHTS = 8;
// Joints a skinned mesh can use; extra joints draw at rest.
export const MAX_JOINTS = 128;

// Bind-space geometry of a skinned primitive (GlbPrimitive.skinned).
export interface SkinnedData {
  positions: Float32Array;
  normals: Float32Array;
  joints: Float32Array;
  weights: Float32Array;
}

export interface Renderer {
  addMesh: (data: MeshData) => number;
  // A mesh deformed by MeshRef.joints. data supplies indices and UVs; skin the bind-space geometry.
  addSkinnedMesh: (data: MeshData, skin: SkinnedData) => number;
  // The scene's draws without presenting a frame, for Draw2D.scene() to put under a 2D HUD in Sim.render.
  draws: (world: World, camera: Camera, environment?: Environment) => Draw[];
  render: (world: World, camera: Camera, clear: Color, environment?: Environment) => void;
}

interface GpuMesh {
  vertexBuffer: number;
  indexBuffer: number;
  count: number;
  uvs: boolean;
  skinned: boolean;
}

interface EntityBinding {
  uniformBuffer: number;
  bindGroup: number;
  texture: Texture;
}

const shader = (skinned: boolean): string => `
struct Light {
  position: vec4f,
  color: vec4f,
}
struct Uniforms {
  mvp: mat4x4f,
  model: mat4x4f,
  color: vec4f,
  material: vec4f,
  eye: vec4f,
  fog: vec4f,
  ambient: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  spotPos: vec4f,
  spotDir: vec4f,
  spotColor: vec4f,
  lights: array<Light, ${MAX_LIGHTS}>,
  ${skinned ? `joints: array<mat4x4f, ${MAX_JOINTS}>,` : ""}
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
}

${
  skinned
    ? `@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) joints: vec4f, @location(4) weights: vec4f) -> VertexOut {
  let skin = u.joints[u32(joints.x)] * weights.x + u.joints[u32(joints.y)] * weights.y + u.joints[u32(joints.z)] * weights.z + u.joints[u32(joints.w)] * weights.w;
  let p = skin * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = u.mvp * p;
  out.normal = (u.model * skin * vec4f(normal, 0.0)).xyz;
  out.world = (u.model * p).xyz;
  out.uv = uv;
  return out;
}`
    : `@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  out.position = u.mvp * vec4f(position, 1.0);
  out.normal = (u.model * vec4f(normal, 0.0)).xyz;
  out.world = (u.model * vec4f(position, 1.0)).xyz;
  out.uv = uv;
  return out;
}`
}

fn falloff(d: f32, range: f32) -> f32 {
  let t = clamp(1.0 - d / max(range, 0.001), 0.0, 1.0);
  return t * t;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  var albedo = u.color.rgb;
  // Sampled unconditionally (uniform control flow); material.y picks what to use: 0 none, 1 triplanar, 2 UVs.
  let texel = textureSample(tex, samp, fract(in.uv));
  if (u.material.y > 1.5) {
    if (texel.a < u.material.z) { discard; }
    albedo = albedo * texel.rgb;
  } else if (u.material.y > 0.5) {
    // Triplanar: three planar projections blended by the normal, so meshes need no UVs.
    let p = in.world / max(u.material.x, 0.001);
    var w = abs(n);
    w = w / (w.x + w.y + w.z);
    let tx = textureSample(tex, samp, fract(p.zy)).rgb;
    let ty = textureSample(tex, samp, fract(p.xz)).rgb;
    let tz = textureSample(tex, samp, fract(p.xy)).rgb;
    albedo = albedo * (tx * w.x + ty * w.y + tz * w.z);
  }
  var light = u.ambient.rgb;
  light += u.sunColor.rgb * max(dot(n, normalize(u.sunDir.xyz)), 0.0);
  for (var i = 0; i < ${MAX_LIGHTS}; i++) {
    let l = u.lights[i];
    if (l.position.w <= 0.0) { continue; }
    let to = l.position.xyz - in.world;
    let d = length(to);
    light += l.color.rgb * max(dot(n, to / max(d, 0.0001)), 0.0) * falloff(d, l.position.w);
  }
  if (u.spotPos.w > 0.0) {
    let to = u.spotPos.xyz - in.world;
    let d = length(to);
    let dir = to / max(d, 0.0001);
    let cone = smoothstep(u.spotDir.w, u.spotColor.w, dot(-dir, normalize(u.spotDir.xyz)));
    light += u.spotColor.rgb * max(dot(n, dir), 0.0) * falloff(d, u.spotPos.w) * cone;
  }
  var color = albedo * light + u.color.rgb * u.color.w;
  if (u.fog.w > 0.0) {
    let d = distance(in.world, u.eye.xyz) * u.fog.w;
    color = mix(u.fog.rgb, color, exp(-d * d));
  }
  if (u.eye.w > 0.0) {
    let x = color * u.eye.w;
    color = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(color, 1.0);
}
`;

// Position, normal, uv; skinned meshes add four joint slots and four weights.
const VERTEX_FLOATS = 8;
const SKINNED_FLOATS = 16;
// mvp (16) + model (16) + 10 vec4 + MAX_LIGHTS * 2 vec4 floats.
const UNIFORM_FLOATS = 32 + 10 * 4 + MAX_LIGHTS * 8;

const DEFAULT_ENVIRONMENT: Environment = {
  ambient: vec3(0.25, 0.25, 0.25),
  sun: { direction: vec3(0.4, 0.8, 0.6), color: vec3(0.75, 0.75, 0.75) },
};

const BASE_ATTRIBUTES = [
  { format: VertexFormat.Float32x3, offset: 0, location: 0 },
  { format: VertexFormat.Float32x3, offset: 12, location: 1 },
  { format: VertexFormat.Float32x2, offset: 24, location: 2 },
];

export function createRenderer(gpu: RenderGpu): Renderer {
  const pipeline = gpu.createPipeline({ wgsl: shader(false), stride: VERTEX_FLOATS * 4, attributes: BASE_ATTRIBUTES, depth: true, blend: false });
  // Created on the first skinned mesh, so games without one pay nothing.
  let skinnedPipeline = -1;
  // The shader always samples, so untextured meshes bind one white pixel.
  const white = gpu.createTexture(1, 1, new Uint8Array([255, 255, 255, 255]), false);
  const meshes: GpuMesh[] = [];
  const bindings = new Map<number, EntityBinding>();
  const uniforms = new Float32Array(UNIFORM_FLOATS);
  const skinnedUniforms = new Float32Array(UNIFORM_FLOATS + MAX_JOINTS * 16);
  const scene = new Float32Array(UNIFORM_FLOATS - 40);

  const addMesh = (data: MeshData): number => {
    const vertexCount = data.positions.length / 3;
    const interleaved = new Float32Array(vertexCount * VERTEX_FLOATS);
    const uvs = data.uvs;
    for (let i = 0; i < vertexCount; i++) {
      const o = i * VERTEX_FLOATS;
      interleaved[o] = data.positions[i * 3];
      interleaved[o + 1] = data.positions[i * 3 + 1];
      interleaved[o + 2] = data.positions[i * 3 + 2];
      interleaved[o + 3] = data.normals[i * 3];
      interleaved[o + 4] = data.normals[i * 3 + 1];
      interleaved[o + 5] = data.normals[i * 3 + 2];
      if (uvs) {
        interleaved[o + 6] = uvs[i * 2];
        interleaved[o + 7] = uvs[i * 2 + 1];
      }
    }
    meshes.push({
      vertexBuffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(interleaved)),
      indexBuffer: gpu.createBuffer(BufferUsage.Index, u32Bytes(data.indices)),
      count: data.indices.length,
      uvs: uvs !== undefined,
      skinned: false,
    });
    return meshes.length - 1;
  };

  const addSkinnedMesh = (data: MeshData, skin: SkinnedData): number => {
    if (skinnedPipeline < 0) {
      skinnedPipeline = gpu.createPipeline({
        wgsl: shader(true),
        stride: SKINNED_FLOATS * 4,
        attributes: [...BASE_ATTRIBUTES, { format: VertexFormat.Float32x4, offset: 32, location: 3 }, { format: VertexFormat.Float32x4, offset: 48, location: 4 }],
        depth: true,
        blend: false,
      });
    }
    const vertexCount = skin.positions.length / 3;
    const interleaved = new Float32Array(vertexCount * SKINNED_FLOATS);
    const uvs = data.uvs;
    for (let i = 0; i < vertexCount; i++) {
      const o = i * SKINNED_FLOATS;
      for (let c = 0; c < 3; c++) {
        interleaved[o + c] = skin.positions[i * 3 + c];
        interleaved[o + 3 + c] = skin.normals[i * 3 + c];
      }
      if (uvs) {
        interleaved[o + 6] = uvs[i * 2];
        interleaved[o + 7] = uvs[i * 2 + 1];
      }
      for (let c = 0; c < 4; c++) {
        // A joint past MAX_JOINTS would index outside the array; its weight falls back to joint 0.
        const joint = skin.joints[i * 4 + c];
        interleaved[o + 8 + c] = joint < MAX_JOINTS ? joint : 0;
        interleaved[o + 12 + c] = skin.weights[i * 4 + c];
      }
    }
    meshes.push({
      vertexBuffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(interleaved)),
      indexBuffer: gpu.createBuffer(BufferUsage.Index, u32Bytes(data.indices)),
      count: data.indices.length,
      uvs: uvs !== undefined,
      skinned: true,
    });
    return meshes.length - 1;
  };

  // The per-frame part of the uniforms, written once and copied into every entity's buffer.
  const writeScene = (camera: Camera, env: Environment): void => {
    scene.fill(0);
    const put = (slot: number, v: Vec3, w: number): void => {
      scene[slot * 4] = v.x;
      scene[slot * 4 + 1] = v.y;
      scene[slot * 4 + 2] = v.z;
      scene[slot * 4 + 3] = w;
    };
    put(0, camera.eye, env.exposure ?? 0);
    if (env.fog) put(1, env.fog.color, env.fog.density);
    put(2, env.ambient, 0);
    if (env.sun) {
      put(3, env.sun.direction, 0);
      put(4, env.sun.color, 0);
    }
    if (env.spot) {
      put(5, env.spot.position, env.spot.range);
      put(6, env.spot.direction, Math.cos(env.spot.angle));
      put(7, env.spot.color, Math.cos(env.spot.angle * 0.6));
    }
    const lights = env.lights ?? [];
    for (let i = 0; i < Math.min(lights.length, MAX_LIGHTS); i++) {
      put(8 + i * 2, lights[i].position, lights[i].range);
      put(9 + i * 2, lights[i].color, 0);
    }
  };

  const draws = (world: World, camera: Camera, environment?: Environment): Draw[] => {
    const view = lookAt(camera.eye, camera.target, vec3(0, 1, 0));
    const viewProjection = multiply(perspective(camera.fovY, gpu.aspect(), camera.near ?? 0.1, camera.far ?? 100), view);
    writeScene(camera, environment ?? DEFAULT_ENVIRONMENT);
    const out: Draw[] = [];
    for (const [entity, meshRef] of world.meshes) {
      const transform = world.transforms.get(entity);
      const mesh = meshes[meshRef.mesh];
      if (!transform || !mesh) continue;

      const texture = meshRef.texture ?? white;
      const entityPipeline = mesh.skinned ? skinnedPipeline : pipeline;
      const data = mesh.skinned ? skinnedUniforms : uniforms;
      let binding = bindings.get(entity);
      if (!binding || binding.texture !== texture) {
        const uniformBuffer = binding?.uniformBuffer ?? gpu.createBuffer(BufferUsage.Uniform, f32Bytes(data));
        binding = { uniformBuffer, bindGroup: gpu.bind(entityPipeline, uniformBuffer, texture.id), texture };
        bindings.set(entity, binding);
      }

      const model = compose(transform.position, transform.rotation, transform.scale);
      uniforms.set(multiply(viewProjection, model), 0);
      uniforms.set(model, 16);
      uniforms[32] = meshRef.color.x;
      uniforms[33] = meshRef.color.y;
      uniforms[34] = meshRef.color.z;
      uniforms[35] = meshRef.emissive ?? 0;
      uniforms[36] = meshRef.tile ?? 1;
      uniforms[37] = !meshRef.texture ? 0 : mesh.uvs && !meshRef.triplanar ? 2 : 1;
      uniforms[38] = meshRef.alphaCutoff ?? 0;
      uniforms[39] = 0;
      uniforms.set(scene, 40);
      if (mesh.skinned) {
        skinnedUniforms.set(uniforms, 0);
        const joints = meshRef.joints;
        for (let j = 0; j < MAX_JOINTS; j++) {
          const o = UNIFORM_FLOATS + j * 16;
          if (joints && j * 16 + 16 <= joints.length) skinnedUniforms.set(joints.subarray(j * 16, j * 16 + 16), o);
          else {
            skinnedUniforms.fill(0, o, o + 16);
            skinnedUniforms[o] = 1;
            skinnedUniforms[o + 5] = 1;
            skinnedUniforms[o + 10] = 1;
            skinnedUniforms[o + 15] = 1;
          }
        }
      }
      gpu.writeBuffer(binding.uniformBuffer, f32Bytes(data));

      out.push({
        pipeline: entityPipeline,
        bindGroup: binding.bindGroup,
        vertexBuffer: mesh.vertexBuffer,
        indexBuffer: mesh.indexBuffer,
        first: 0,
        count: mesh.count,
      });
    }
    return out;
  };

  const render = (world: World, camera: Camera, clear: Color, environment?: Environment): void =>
    gpu.frame(clear, draws(world, camera, environment));

  return { addMesh, addSkinnedMesh, draws, render };
}
