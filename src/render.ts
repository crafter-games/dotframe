import type { InstanceCell, Instances, World } from "./ecs";
import type { MeshData } from "./gltf";
import { BufferUsage, type Color, type Draw, f32Bytes, type RenderGpu, type Texture, u32Bytes, VertexFormat } from "./gpu";
import { compose, lookAt, multiply, orthographic, perspective, type Vec3, vec3 } from "./math";
import { PARTICLE_FLOATS } from "./particles";

export interface Camera {
  eye: Vec3;
  target: Vec3;
  fovY: number;
  // Clip planes; default 0.1 and 100.
  near?: number;
  far?: number;
  // Render layers this camera draws, a bitmask (default 1): a mesh shows when MeshRef.layers shares a bit, so a
  // viewfinder can see what the bare eye does not (Godot cull_mask).
  layers?: number;
  // Width over height of the image; defaults to the surface's (gpu.aspect). Set it when drawing into a target of
  // another shape, such as a 4:3 tape for an in-game TV.
  aspect?: number;
  // Turn about the view direction, in radians (positive turns the camera's up toward its right): a hand-held or fallen
  // camera.
  roll?: number;
  // A camera inside the scene (the one filming an in-game TV's picture): snap --camera does not replace it.
  fixed?: boolean;
}

// Per-entity GPU buffers are cached by this key, so two worlds drawn by one renderer (an in-game TV's set and the
// scene) keep their own.
function entityKey(world: World, entity: number): number {
  return (world.id ?? 0) * 1048576 + entity;
}

// The up vector for a camera rolled about its view direction.
function rolledUp(camera: Camera): Vec3 {
  const roll = camera.roll ?? 0;
  if (roll === 0) return vec3(0, 1, 0);
  let fx = camera.target.x - camera.eye.x;
  let fy = camera.target.y - camera.eye.y;
  let fz = camera.target.z - camera.eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward x up(0,1,0); camera up = right x forward.
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return vec3(ux * c + rx * s, uy * c, uz * c + rz * s);
}

// Replaces the game's camera in every draws() call while set (snap --camera): eye, target and fovY; the game's
// clip planes stay. Presentation only, so the simulation never sees it.
export const cameraOverride: { camera: Camera | null } = { camera: null };

export interface PointLight {
  position: Vec3;
  color: Vec3;
  // Distance where the light reaches zero.
  range: number;
  // Walls without a shadow map: the light reaches only fragments inside this box, or with outside, only those
  // outside it (a lamp in a room, a street light kept out of the house).
  box?: { min: Vec3; max: Vec3; outside?: boolean };
  // How much this light glows in the fog when Environment.fog.scatter is on (Godot light_volumetric_fog_energy,
  // default 1).
  fog?: number;
}

// A box of thicker fog (Godot FogVolume): density per meter at its floor, thinning upward by exp(-falloff * height).
export interface FogVolume {
  min: Vec3;
  max: Vec3;
  density: number;
  falloff?: number;
}
export const MAX_FOG_VOLUMES = 4;

export interface SpotLight extends PointLight {
  direction: Vec3;
  // Half angle of the cone, in radians.
  angle: number;
  // Static meshes cast shadows from this light (a SHADOW_SIZE map rendered each frame).
  shadows?: boolean;
}

// The shadow map is SHADOW_SIZE * 2 wide: the spot's half on the left, the sun's on the right.
export const SHADOW_SIZE = 1024;

// Lighting for one frame. Leaving it out keeps the default: a fixed key light and no fog.
export interface Environment {
  ambient: Vec3;
  // Direction the light comes from (towards the light).
  // shadows: static meshes cast shadows from it within this many meters of the eye (an orthographic map that follows
  // the camera, snapped to its texels so edges hold still).
  sun?: { direction: Vec3; color: Vec3; shadows?: number };
  // scatter: light the fog in front of a surface throws toward the eye, so point lights get halos (a stand-in for
  // Godot's volumetric fog, computed in closed form per fragment, no extra pass). volumes add thicker boxes of the
  // same fog color, at most MAX_FOG_VOLUMES.
  fog?: { color: Vec3; density: number; scatter?: number; volumes?: FogVolume[] };
  // Any number: each frame the renderer keeps the MAX_LIGHTS that matter for the view (pickLights).
  lights?: PointLight[];
  spot?: SpotLight;
  // More spot lights, lit together with spot (at most MAX_SPOTS in all). Only one casts shadows, the first that asks
  // (spot before spots), on every platform: one map keeps phones at the cost they had.
  spots?: SpotLight[];
  // Turns on ACES filmic tonemapping at this exposure, so bright lights roll off instead of clipping to white.
  exposure?: number;
  // Seconds, for wind on instanced meshes (MeshRef.sway). Pass simulation time so a frame renders the same twice.
  time?: number;
  // Soft round billboards drawn after the scene, blended, tested against depth (src/particles: PARTICLE_FLOATS
  // each, final colors, fogged here).
  particles?: number[];
  // The same billboards added to what is behind them instead of blended over it (fire, sparks, embers): order does
  // not matter, and fog fades them out.
  glow?: number[];
  // A sky drawn behind everything (where nothing else writes depth): a gradient, an optional sun disc, moon, stars
  // and Milky Way. Without it the frame's clear color shows.
  sky?: Sky;
}

export interface Sky {
  zenith: Vec3;
  horizon: Vec3;
  // Below the horizon; defaults to the horizon color darkened.
  ground?: Vec3;
  // How fast the horizon color gives way to the zenith going up (Godot's sky_curve); default 0.15.
  curve?: number;
  // Multiplies the whole sky; default 1.
  energy?: number;
  // size is the disc's angular radius in radians.
  sun?: { direction: Vec3; color: Vec3; size: number };
  // texture (optional) is wrapped on the disc like a lit sphere.
  moon?: { direction: Vec3; color: Vec3; size: number; texture?: Texture };
  // Star brightness (0: none) and Milky Way strength; stars twinkle with Environment.time.
  stars?: number;
  milkyWay?: number;
  // A low warm glow toward a direction on the horizon (a town).
  glow?: { direction: Vec3; color: Vec3 };
}

// Full-screen triangle; each pixel's view ray picks the sky color. Ported from The Ones' night_sky.gdshader and
// Godot's ProceduralSkyMaterial gradient.
const SKY_SHADER = `
struct Sky {
  right: vec4f,
  up: vec4f,
  forward: vec4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  moonDir: vec4f,
  moonColor: vec4f,
  glowDir: vec4f,
  glowColor: vec4f,
}
@group(0) @binding(0) var<uniform> u: Sky;
@group(0) @binding(1) var moonTex: texture_2d<f32>;
@group(0) @binding(2) var moonSampler: sampler;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) ndc: vec2f,
}
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var out: Out;
  out.position = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}
fn hash3(q: vec3f) -> f32 {
  var p = fract(q * vec3f(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), f.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), f.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), f.x), f.y), f.z);
}
fn fbm(q: vec3f) -> f32 {
  var p = q;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) {
    v += a * noise3(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
fn stars(d: vec3f, scale: f32, threshold: f32, time: f32) -> f32 {
  let p = d * scale;
  let cell = floor(p);
  let h = hash3(cell);
  if (h < threshold) { return 0.0; }
  let center = cell + vec3f(hash3(cell + 1.3), hash3(cell + 2.7), hash3(cell + 4.1));
  let b = (h - threshold) / (1.0 - threshold);
  let twinkle = 0.75 + 0.25 * sin(time * (1.5 + h * 4.0) + h * 40.0);
  return smoothstep(0.12, 0.0, length(p - center)) * (0.25 + 0.75 * b) * twinkle;
}
@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let d = normalize(u.forward.xyz + u.right.xyz * in.ndc.x * u.right.w + u.up.xyz * in.ndc.y * u.up.w);
  let curve = u.ground.w;
  let c = 1.0 - acos(clamp(d.y, -1.0, 1.0)) / 1.5707963;
  var col: vec3f;
  if (d.y >= 0.0) {
    col = mix(u.horizon.rgb, u.zenith.rgb, clamp(1.0 - pow(1.0 - c, 1.0 / curve), 0.0, 1.0));
  } else {
    col = mix(u.horizon.rgb * 0.7, u.ground.rgb, clamp(1.0 - pow(1.0 + c, 1.0 / 0.02), 0.0, 1.0));
  }
  let up = clamp(d.y, -0.2, 1.0);
  if (u.glowColor.w > 0.0) {
    let flat = normalize(vec3f(d.x, 0.0, d.z) + vec3f(0.0001, 0.0, 0.0));
    col += u.glowColor.rgb * pow(max(dot(flat, normalize(u.glowDir.xyz)), 0.0), 6.0) * smoothstep(0.25, 0.0, up) * 0.6;
  }
  let starEnergy = u.sunColor.w;
  let milky = u.moonColor.w;
  let band = exp(-pow(dot(d, normalize(vec3f(0.35, 0.25, 0.9))) / 0.22, 2.0));
  if (milky > 0.0) {
    col += vec3f(0.05, 0.055, 0.07) * band * (0.4 + 0.6 * smoothstep(0.3, 0.75, fbm(d * 3.0 + vec3f(11.0)))) * milky;
  }
  if (starEnergy > 0.0) {
    let time = u.forward.w;
    var s = stars(d, 90.0, 0.966, time) * 1.6;
    s += stars(d, 220.0, 0.949, time) * 0.9;
    s += stars(d, 480.0, 0.915, time) * 0.5 * (0.3 + band * 1.4);
    let tint = mix(vec3f(0.75, 0.82, 1.0), vec3f(1.0, 0.88, 0.75), hash3(floor(d * 220.0)));
    col += tint * s * starEnergy * smoothstep(-0.02, 0.12, d.y);
  }
  if (u.sunDir.w > 0.0) {
    let a = acos(clamp(dot(d, normalize(u.sunDir.xyz)), -1.0, 1.0));
    col = mix(col, u.sunColor.rgb, smoothstep(u.sunDir.w, u.sunDir.w * 0.6, a));
    col += u.sunColor.rgb * 0.12 * pow(max(dot(d, normalize(u.sunDir.xyz)), 0.0), 64.0);
  }
  if (u.moonDir.w > 0.0) {
    let md = normalize(u.moonDir.xyz);
    let k = dot(d, md);
    if (k > 0.0) {
      let right = normalize(cross(md, vec3f(0.0, 1.0, 0.0)));
      let upv = cross(right, md);
      let uv = vec2f(dot(d, right), dot(d, upv)) / u.moonDir.w;
      let r = length(uv);
      let z = sqrt(max(1.0 - r * r, 0.0));
      let tuv = vec2f(0.5 + atan2(uv.x, z) / 6.2831853, 0.5 - asin(clamp(uv.y, -1.0, 1.0)) / 3.14159265);
      var m = textureSampleLevel(moonTex, moonSampler, tuv, 0.0).rgb;
      col = mix(col, m * u.moonColor.rgb * pow(z, 0.35), smoothstep(1.0, 0.97, r));
      col += vec3f(0.5, 0.58, 0.72) * pow(k, 900.0) * 0.6;
      col += vec3f(0.2, 0.25, 0.35) * pow(k, 40.0) * 0.08;
    }
  }
  col *= u.horizon.w;
  if (u.zenith.w > 0.0) {
    let x = col * u.zenith.w;
    col = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(col, 1.0);
}
`;
const SKY_FLOATS = 48;

// Floats per instance in addInstances: x, y, z, scale, yaw, sway phase, 0, 0.
export const INSTANCE_FLOATS = 8;
// Instanced meshes are split into square ground cells this many meters wide.
export const INSTANCE_CELL = 16;
// On mobile, an instance set keeps full density while its mesh's radius over the distance stays above this (a 0.5 m
// rice tuft out to 6 m, a 12 m tree out to 150 m), then thins as the square of that ratio, never below the floor.
// Measured on an iPhone 14 class (A16): 0.04 left The Ones GPU-bound, 0.08 holds 60 fps.
// Grazing views overlap far instances, so the thinning hardly shows; desktops draw every instance.
export const INSTANCE_DETAIL = { size: 0.08, floor: 0.08 };

export const MAX_LIGHTS = 8;
export const MAX_SPOTS = 4;
// Joints a skinned mesh can use (Character Creator rigs have ~150); extra joints draw at rest. 256 joints are 16 KB
// of uniforms, under the 64 KB WebGPU guarantees.
export const MAX_JOINTS = 256;

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
  // Uploads instances (INSTANCE_FLOATS each) for MeshRef.instances.
  addInstances: (data: Float32Array) => Instances;
  // Rewrites an instance set in place with the same number of instances (rice laid down as it is walked over).
  // Costs an upload of the whole set, so call it when the data changes, not every frame out of habit.
  updateInstances: (instances: Instances, data: Float32Array) => void;
  // The scene's draws without presenting a frame, for Draw2D.scene() to put under a 2D HUD in Sim.render.
  draws: (world: World, camera: Camera, environment?: Environment) => Draw[];
  render: (world: World, camera: Camera, clear: Color, environment?: Environment) => void;
  // A material for MeshRef.material: WGSL defining fn surface(s: SurfaceIn) -> Surface (Godot's fragment()). It may
  // sample tex with samp (MeshRef.texture) and read MeshRef.params. Built-in lighting, shadows and fog apply to it.
  createMaterial: (wgsl: string) => number;
}

interface GpuMesh {
  // Farthest vertex from the origin, for culling instance cells.
  radius: number;
  vertexBuffer: number;
  indexBuffer: number;
  count: number;
  uvs: boolean;
  skinned: boolean;
}

interface EntityBinding {
  pipeline: number;
  uniformBuffer: number;
  bindGroup: number;
  texture: Texture;
}

// Camera-facing soft discs. corner is a quad corner in [-1, 1]; the camera's right and up span the billboard.
const PARTICLE_SHADER = `
struct Uniforms {
  viewProjection: mat4x4f,
  eye: vec4f,
  right: vec4f,
  up: vec4f,
  fog: vec4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) color: vec4f,
  @location(2) world: vec3f,
}
@vertex fn vs_main(@location(0) corner: vec2f, @location(1) center: vec4f, @location(2) color: vec4f) -> Out {
  let world = center.xyz + (u.right.xyz * corner.x + u.up.xyz * corner.y) * center.w * 0.5;
  var out: Out;
  out.position = u.viewProjection * vec4f(world, 1.0);
  out.corner = corner;
  out.color = color;
  out.world = world;
  return out;
}
@fragment fn fs_main(in: Out) -> @location(0) vec4f {
  let r2 = dot(in.corner, in.corner);
  if (r2 >= 1.0) { discard; }
  let soft = (1.0 - r2) * (1.0 - r2);
  var color = in.color.rgb;
  if (u.fog.w > 0.0) {
    let d = distance(in.world, u.eye.xyz) * u.fog.w;
    color = mix(u.fog.rgb * (1.0 - u.eye.w), color, exp(-d * d));
  }
  return vec4f(color, clamp(in.color.a * soft, 0.0, 1.0));
}
`;

// What a custom material's surface() gets and returns (Renderer.createMaterial). Lighting, shadows, fog and exposure
// stay the built-in ones, applied to the returned albedo; emission is added after lighting, unlit.
const SURFACE_TYPES = `
struct SurfaceIn {
  world: vec3f,
  normal: vec3f,
  uv: vec2f,
  // Unit vector from the surface to the eye.
  view: vec3f,
  // MeshRef.color, and MeshRef.params as two vec4s.
  color: vec3f,
  params0: vec4f,
  params1: vec4f,
  // Environment.time.
  time: f32,
}
struct Surface {
  albedo: vec3f,
  emission: vec3f,
}
`;

// kind 0 static, 1 skinned, 2 instanced, 3 shadow casters. surface is a material's WGSL (createMaterial).
const shader = (kind: number, surface?: string): string => {
  const skinned = kind === 1;
  return `
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
  shadowVP: mat4x4f,
  // x on, y bias (fraction of the spot's range), z one texel in uv.
  shadowParams: vec4f,
  sunVP: mat4x4f,
  // x on, y bias (fraction of the box depth).
  sunParams: vec4f,
  // Per light: min.xyz and w (0 none, 1 inside, 2 outside), then max.xyz.
  lightBoxes: array<vec4f, ${MAX_LIGHTS * 2}>,
  // The spots after the main one: position and range, direction and outer cosine, color and inner cosine.
  spots: array<vec4f, ${(MAX_SPOTS - 1) * 3}>,
  // x scatter, y fog volume count; then per volume min.xyz and density, max.xyz and falloff.
  fogScatter: vec4f,
  fogVolumes: array<vec4f, ${MAX_FOG_VOLUMES * 2}>,
  params: array<vec4f, 2>,
  ${skinned ? `joints: array<mat4x4f, ${MAX_JOINTS}>,` : ""}
}
@group(0) @binding(0) var<uniform> u: Uniforms;
${
  kind === 3
    ? ""
    : `@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var shadowTex: texture_2d<f32>;
@group(0) @binding(4) var shadowSamp: sampler;`
}

// Depth as a fraction of the spot's range, in the 24 bits of an 8-bit RGB target.
fn packDepth(d: f32) -> vec3f {
  var e = fract(clamp(d, 0.0, 0.99999) * vec3f(1.0, 255.0, 65025.0));
  e -= e.yzz * vec3f(1.0 / 255.0, 1.0 / 255.0, 0.0);
  return e;
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
}

${
  kind === 2
    ? `@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) place: vec4f, @location(4) spin: vec4f) -> VertexOut {
  let c = cos(spin.x);
  let s = sin(spin.x);
  var local = vec3f(c * position.x + s * position.z, position.y, -s * position.x + c * position.z) * place.w;
  // Wind bends the top more than the base.
  let t = u.sunDir.w;
  local.x += sin(t * 1.7 + spin.y) * u.material.w * position.y * place.w;
  local.z += cos(t * 1.3 + spin.y * 1.3) * u.material.w * 0.5 * position.y * place.w;
  let p = vec4f(local + place.xyz, 1.0);
  var out: VertexOut;
  out.position = u.mvp * p;
  out.normal = (u.model * vec4f(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z, 0.0)).xyz;
  out.world = (u.model * p).xyz;
  out.uv = uv;
  return out;
}`
    : skinned
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

${
  kind === 3
    ? `@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  // color.x picks the half: 0 the spot, 1 the sun. Fragments outside that light's own frustum would spill into the
  // other half, so they go.
  let sun = u.color.x > 0.5;
  var clip = u.shadowVP * vec4f(in.world, 1.0);
  if (sun) { clip = u.sunVP * vec4f(in.world, 1.0); }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { discard; }
  if (sun) { return vec4f(packDepth(ndc.z), 1.0); }
  return vec4f(packDepth(distance(in.world, u.spotPos.xyz) / u.spotPos.w), 1.0);
}`
    : `fn spotShadow(world: vec3f) -> f32 {
  if (u.shadowParams.x < 0.5) { return 1.0; }
  let clip = u.shadowVP * vec4f(world, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { return 1.0; }
  let uv = vec2f((ndc.x * 0.5 + 0.5) * 0.5, 0.5 - ndc.y * 0.5);
  return shadowTaps(uv, distance(world, u.spotPos.xyz) / u.spotPos.w - u.shadowParams.y);
}

fn sunShadow(world: vec3f) -> f32 {
  if (u.sunParams.x < 0.5) { return 1.0; }
  let ndc = (u.sunVP * vec4f(world, 1.0)).xyz;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0) { return 1.0; }
  let uv = vec2f(0.5 + (ndc.x * 0.5 + 0.5) * 0.5, 0.5 - ndc.y * 0.5);
  return shadowTaps(uv, ndc.z - u.sunParams.y);
}

// Four taps a texel and a half apart; the map is twice as wide as tall.
fn shadowTaps(uv: vec2f, d: f32) -> f32 {
  var lit = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = (vec2f(f32(i % 2), f32(i / 2)) - 0.5) * u.shadowParams.z * 1.5 * vec2f(0.5, 1.0);
    let stored = dot(textureSampleLevel(shadowTex, shadowSamp, uv + o, 0.0).rgb, vec3f(1.0, 1.0 / 255.0, 1.0 / 65025.0));
    lit += select(0.0, 1.0, d <= stored);
  }
  return lit / 4.0;
}

// 0 when a light box keeps this fragment out.
fn boxed(i: i32, world: vec3f) -> f32 {
  let lo = u.lightBoxes[i * 2];
  if (lo.w < 0.5) { return 1.0; }
  let hi = u.lightBoxes[i * 2 + 1].xyz;
  let inside = all(world >= lo.xyz) && all(world <= hi);
  return select(0.0, 1.0, inside == (lo.w < 1.5));
}

${surface ? `${SURFACE_TYPES}
${surface}
` : ""}
@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  ${
    surface
      ? `let s = surface(SurfaceIn(in.world, n, in.uv, normalize(u.eye.xyz - in.world), u.color.rgb, u.params[0], u.params[1], u.sunDir.w));
  let albedo = s.albedo;`
      : `var albedo = u.color.rgb;
  // Sampled unconditionally (uniform control flow); material.y picks what to use: 0 none, 1 triplanar, 2 UVs.
  // No fract: tiled textures use a repeating sampler (mipmaps), and fract's seams would pick the smallest mip.
  let texel = textureSample(tex, samp, in.uv);
  if (u.material.y > 1.5) {
    if (texel.a < u.material.z) { discard; }
    albedo = albedo * texel.rgb;
  } else if (u.material.y > 0.5) {
    // Triplanar: three planar projections blended by the normal, so meshes need no UVs.
    let p = in.world / max(u.material.x, 0.001);
    var w = abs(n);
    w = w / (w.x + w.y + w.z);
    let tx = textureSample(tex, samp, p.zy).rgb;
    let ty = textureSample(tex, samp, p.xz).rgb;
    let tz = textureSample(tex, samp, p.xy).rgb;
    albedo = albedo * (tx * w.x + ty * w.y + tz * w.z);
  }`
  }
  var light = u.ambient.rgb;
  let sunLit = max(dot(n, normalize(u.sunDir.xyz)), 0.0);
  // Uniform control flow for the shadow taps: sampled whatever sunLit is.
  light += u.sunColor.rgb * sunLit * sunShadow(in.world);
  for (var i = 0; i < ${MAX_LIGHTS}; i++) {
    let l = u.lights[i];
    if (l.position.w <= 0.0) { continue; }
    let to = l.position.xyz - in.world;
    let d = length(to);
    light += l.color.rgb * max(dot(n, to / max(d, 0.0001)), 0.0) * falloff(d, l.position.w) * boxed(i, in.world);
  }
  if (u.spotPos.w > 0.0) {
    let to = u.spotPos.xyz - in.world;
    let d = length(to);
    let dir = to / max(d, 0.0001);
    let cone = smoothstep(u.spotDir.w, u.spotColor.w, dot(-dir, normalize(u.spotDir.xyz)));
    light += u.spotColor.rgb * max(dot(n, dir), 0.0) * falloff(d, u.spotPos.w) * cone * spotShadow(in.world);
  }
  for (var i = 0; i < ${MAX_SPOTS - 1}; i++) {
    let p = u.spots[i * 3];
    if (p.w <= 0.0) { continue; }
    let to = p.xyz - in.world;
    let d = length(to);
    let dir = to / max(d, 0.0001);
    let sd = u.spots[i * 3 + 1];
    let sc = u.spots[i * 3 + 2];
    light += sc.rgb * max(dot(n, dir), 0.0) * falloff(d, p.w) * smoothstep(sd.w, sc.w, dot(-dir, normalize(sd.xyz)));
  }
  var color = albedo * (light + vec3f(u.color.w))${surface ? " + s.emission" : ""};
  if (u.fog.w > 0.0) {
    let d = distance(in.world, u.eye.xyz) * u.fog.w;
    color = mix(u.fog.rgb, color, exp(-d * d));
  }
  color = volumeFog(in.world, color);
  if (u.eye.w > 0.0) {
    let x = color * u.eye.w;
    color = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(color, 1.0);
}
`
}

// Fog volumes, then the light the fog scatters toward the eye, along the ray from the eye to this fragment.
fn volumeFog(world: vec3f, base: vec3f) -> vec3f {
  let count = i32(u.fogScatter.y);
  if (count == 0 && u.fogScatter.x <= 0.0) { return base; }
  let e = u.eye.xyz;
  let ray = world - e;
  let len = max(length(ray), 0.0001);
  let v = ray / len;
  var depth = 0.0;
  for (var i = 0; i < ${MAX_FOG_VOLUMES}; i++) {
    if (i >= count) { break; }
    let lo = u.fogVolumes[i * 2];
    let hi = u.fogVolumes[i * 2 + 1];
    // Slab test: the part of the ray inside the box.
    let inv = 1.0 / select(v, vec3f(0.000001), abs(v) < vec3f(0.000001));
    let t0 = (lo.xyz - e) * inv;
    let t1 = (hi.xyz - e) * inv;
    let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
    let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), len));
    if (far <= near) { continue; }
    // Mean of exp(-falloff * height above the floor) over the segment, in closed form.
    let y0 = e.y + v.y * near - lo.y;
    let y1 = e.y + v.y * far - lo.y;
    var mean = 1.0;
    if (hi.w > 0.0) {
      mean = select(exp(-hi.w * y0), (exp(-hi.w * y0) - exp(-hi.w * y1)) / (hi.w * (y1 - y0)), abs(y1 - y0) > 0.001);
    }
    depth += lo.w * mean * (far - near);
  }
  var color = mix(u.fog.rgb, base, exp(-depth));
  if (u.fogScatter.x > 0.0) {
    var glow = vec3f(0.0);
    for (var i = 0; i < ${MAX_LIGHTS}; i++) {
      let l = u.lights[i];
      if (l.position.w <= 0.0) { continue; }
      // 1 / distance² to the light integrated along the ray: (atan((len - t) / h) + atan(t / h)) / h, t the closest
      // point and h the ray's distance from the light.
      let t = dot(l.position.xyz - e, v);
      let h = max(length(l.position.xyz - (e + v * t)), 0.05);
      let along = (atan((len - t) / h) + atan(t / h)) / h;
      glow += l.color.rgb * l.color.w * along * falloff(h, l.position.w);
    }
    color += glow * u.fogScatter.x * (u.fog.w + depth / len) * 0.25;
  }
  return color;
}

fn falloff(d: f32, range: f32) -> f32 {
  let t = clamp(1.0 - d / max(range, 0.001), 0.0, 1.0);
  return t * t;
}

`;
};

// Position, normal, uv; skinned meshes add four joint slots and four weights.
const VERTEX_FLOATS = 8;
const SKINNED_FLOATS = 16;
// mvp (16) + model (16) + 10 vec4 + MAX_LIGHTS * 2 vec4 + shadowVP (16) + shadowParams (4) + sunVP (16) +
// sunParams (4) + MAX_LIGHTS * 2 vec4 of light boxes + 3 vec4 per extra spot + fog scatter and volumes + 2 vec4 of
// material params.
const UNIFORM_FLOATS = 32 + 10 * 4 + MAX_LIGHTS * 8 + 40 + MAX_LIGHTS * 8 + (MAX_SPOTS - 1) * 12 + 4 + MAX_FOG_VOLUMES * 8 + 8;
const PARAMS_SLOT = UNIFORM_FLOATS - 8;
// Where shadowVP, sunVP and the light boxes start in the scene block (which starts at float 40).
const SHADOW_SLOT = 8 * 4 + MAX_LIGHTS * 8;
const SUN_SLOT = SHADOW_SLOT + 20;
const BOX_SLOT = SUN_SLOT + 20;
const SPOTS_SLOT = BOX_SLOT + MAX_LIGHTS * 8;
const FOG_SLOT = SPOTS_SLOT + (MAX_SPOTS - 1) * 12;

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
  const pipelineFor = (kind: number, surface?: string): number =>
    gpu.createPipeline(
      kind === 1
        ? {
            wgsl: shader(1, surface),
            stride: SKINNED_FLOATS * 4,
            attributes: [...BASE_ATTRIBUTES, { format: VertexFormat.Float32x4, offset: 32, location: 3 }, { format: VertexFormat.Float32x4, offset: 48, location: 4 }],
            depth: true,
            blend: false,
          }
        : kind === 2
          ? {
              wgsl: shader(2, surface),
              stride: VERTEX_FLOATS * 4,
              attributes: BASE_ATTRIBUTES,
              depth: true,
              blend: false,
              instanceStride: INSTANCE_FLOATS * 4,
              instanceAttributes: [
                { format: VertexFormat.Float32x4, offset: 0, location: 3 },
                { format: VertexFormat.Float32x4, offset: 16, location: 4 },
              ],
            }
          : { wgsl: shader(0, surface), stride: VERTEX_FLOATS * 4, attributes: BASE_ATTRIBUTES, depth: true, blend: false },
    );
  const pipeline = pipelineFor(0);
  // Custom materials' WGSL, and their pipelines by kind, made on first draw.
  const materials: string[] = [];
  const materialPipelines = new Map<number, number>();
  const createMaterial = (wgsl: string): number => materials.push(wgsl) - 1;
  // Created on the first skinned mesh or instance set, so games without one pay nothing.
  let skinnedPipeline = -1;
  let instancedPipeline = -1;
  // The shader always samples, so untextured meshes bind one white pixel.
  const white = gpu.createTexture(1, 1, new Uint8Array([255, 255, 255, 255]), false);
  // Every lit pipeline samples the shadow map, so it exists from the start; it is drawn only when a spot asks.
  const shadowMap = gpu.createTarget(SHADOW_SIZE * 2, SHADOW_SIZE);
  const shadowPipeline = gpu.createPipeline({ wgsl: shader(3), stride: VERTEX_FLOATS * 4, attributes: BASE_ATTRIBUTES, depth: true, blend: false });
  // One binding per world, entity and light (entityKey * 2 + 1 for the sun).
  const shadowBindings = new Map<number, number[]>();
  const shadowUniforms = new Float32Array(UNIFORM_FLOATS);
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
      radius: meshRadius(data.positions),
      vertexBuffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(interleaved)),
      indexBuffer: gpu.createBuffer(BufferUsage.Index, u32Bytes(data.indices)),
      count: data.indices.length,
      uvs: uvs !== undefined,
      skinned: false,
    });
    return meshes.length - 1;
  };

  const addSkinnedMesh = (data: MeshData, skin: SkinnedData): number => {
    if (skinnedPipeline < 0) skinnedPipeline = pipelineFor(1);
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
      radius: meshRadius(skin.positions),
      vertexBuffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(interleaved)),
      indexBuffer: gpu.createBuffer(BufferUsage.Index, u32Bytes(data.indices)),
      count: data.indices.length,
      uvs: uvs !== undefined,
      skinned: true,
    });
    return meshes.length - 1;
  };

  let shadowVP: Float32Array | null = null;
  let sunVP: Float32Array | null = null;
  // Clip x squeezed into one half of the map: [-1, 1] to [-1, 0] (spot) or [0, 1] (sun).
  const half = (side: number): Float32Array => {
    const m = new Float32Array(16);
    m[0] = 0.5;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    m[12] = side * 0.5;
    return m;
  };
  const spotHalf = half(-1);
  const sunHalf = half(1);
  // The per-frame part of the uniforms, written once and copied into every entity's buffer.
  const writeScene = (camera: Camera, env: Environment, viewProjection: Float32Array): void => {
    scene.fill(0);
    const put = (slot: number, v: Vec3, w: number): void => {
      scene[slot * 4] = v.x;
      scene[slot * 4 + 1] = v.y;
      scene[slot * 4 + 2] = v.z;
      scene[slot * 4 + 3] = w;
    };
    put(0, camera.eye, env.exposure ?? 0);
    if (env.fog) {
      put(1, env.fog.color, env.fog.density);
      const volumes = (env.fog.volumes ?? []).slice(0, MAX_FOG_VOLUMES);
      scene[FOG_SLOT] = env.fog.scatter ?? 0;
      scene[FOG_SLOT + 1] = volumes.length;
      volumes.forEach((f: FogVolume, i: number): void => {
        scene.set([f.min.x, f.min.y, f.min.z, f.density, f.max.x, f.max.y, f.max.z, f.falloff ?? 0], FOG_SLOT + 4 + i * 8);
      });
    }
    put(2, env.ambient, 0);
    if (env.sun) {
      put(3, env.sun.direction, 0);
      put(4, env.sun.color, 0);
    }
    // sunDir.w carries the time, sun or not.
    scene[15] = env.time ?? 0;
    // The main slot holds the spot that casts shadows (the first that asks), else the first; the rest follow it.
    const all = [...(env.spot ? [env.spot] : []), ...(env.spots ?? [])].slice(0, MAX_SPOTS);
    const shadowed = all.findIndex((sp: SpotLight): boolean => sp.shadows === true);
    const main = shadowed >= 0 ? shadowed : 0;
    let slot = 0;
    all.forEach((sp: SpotLight, i: number): void => {
      const base = i === main ? 5 : SPOTS_SLOT / 4 + slot++ * 3;
      put(base, sp.position, sp.range);
      put(base + 1, sp.direction, Math.cos(sp.angle));
      put(base + 2, sp.color, Math.cos(sp.angle * 0.6));
    });
    shadowVP = null;
    if (shadowed >= 0) {
      const sp = all[shadowed];
      const up = Math.abs(sp.direction.y) > 0.99 ? vec3(0, 0, 1) : vec3(0, 1, 0);
      const target = vec3(sp.position.x + sp.direction.x, sp.position.y + sp.direction.y, sp.position.z + sp.direction.z);
      shadowVP = multiply(perspective(Math.min(sp.angle * 2.2, 3), 1, 0.05, sp.range), lookAt(sp.position, target, up));
      scene.set(shadowVP, SHADOW_SLOT);
      scene[SHADOW_SLOT + 16] = 1;
      scene[SHADOW_SLOT + 17] = 0.004;
    }
    scene[SHADOW_SLOT + 18] = 1 / SHADOW_SIZE;
    sunVP = null;
    const reach = env.sun ? env.sun.shadows ?? 0 : 0;
    if (env.sun && reach > 0) {
      const d = env.sun.direction;
      const dl = Math.hypot(d.x, d.y, d.z) || 1;
      const dir = vec3(d.x / dl, d.y / dl, d.z / dl);
      const up = Math.abs(dir.y) > 0.99 ? vec3(0, 0, 1) : vec3(0, 1, 0);
      // Centered on the eye, snapped to whole texels in light space so the map does not swim as the camera moves.
      const view = lookAt(vec3(0, 0, 0), vec3(-dir.x, -dir.y, -dir.z), up);
      const texel = (reach * 2) / SHADOW_SIZE;
      const e = camera.eye;
      const lx = Math.floor((view[0] * e.x + view[4] * e.y + view[8] * e.z) / texel) * texel;
      const ly = Math.floor((view[1] * e.x + view[5] * e.y + view[9] * e.z) / texel) * texel;
      const lz = view[2] * e.x + view[6] * e.y + view[10] * e.z;
      // Back to world: the rows of the view rotation are the light's axes.
      const center = vec3(view[0] * lx + view[1] * ly + view[2] * lz, view[4] * lx + view[5] * ly + view[6] * lz, view[8] * lx + view[9] * ly + view[10] * lz);
      const depth = reach * 3;
      const eye = vec3(center.x + dir.x * depth * 0.5, center.y + dir.y * depth * 0.5, center.z + dir.z * depth * 0.5);
      sunVP = multiply(orthographic(reach, 0, depth), lookAt(eye, center, up));
      scene.set(sunVP, SUN_SLOT);
      scene[SUN_SLOT + 16] = 1;
      // A fixed 0.15 m along the light, as a fraction of the box depth.
      scene[SUN_SLOT + 17] = 0.15 / depth;
    }
    const lights = pickLights(env.lights ?? [], viewProjection, camera.eye);
    for (let i = 0; i < lights.length; i++) {
      put(8 + i * 2, lights[i].position, lights[i].range);
      put(9 + i * 2, lights[i].color, lights[i].fog ?? 1);
      const b = lights[i].box;
      if (b) {
        scene.set([b.min.x, b.min.y, b.min.z, b.outside ? 2 : 1, b.max.x, b.max.y, b.max.z, 0], BOX_SLOT + i * 8);
      }
    }
  };

  const addInstances = (data: Float32Array): Instances => {
    if (instancedPipeline < 0) instancedPipeline = pipelineFor(2);
    const split = splitCells(data);
    return { buffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(split.data)), count: data.length / INSTANCE_FLOATS, cells: split.cells };
  };

  const updateInstances = (instances: Instances, data: Float32Array): void => {
    if (data.length / INSTANCE_FLOATS !== instances.count) throw new Error(`updateInstances: ${data.length / INSTANCE_FLOATS} instances for a set of ${instances.count}`);
    const split = splitCells(data);
    gpu.writeBuffer(instances.buffer, f32Bytes(split.data));
    instances.cells = split.cells;
  };

  // Particles: per blend mode one pipeline, quad and uniform buffer, made on first use; the instance buffer grows as
  // needed. Blended ones are sorted back to front; additive ones (Environment.glow) add up in any order.
  const particleSet = (additive: boolean) => {
    const particle = { pipeline: -1, quad: -1, indices: -1, uniforms: -1, bindGroup: -1, instances: -1, capacity: 0 };
    const particleUniforms = new Float32Array(32);
    return (camera: Camera, viewProjection: Float32Array, view: Float32Array, env: Environment): Draw | null => {
      const list = (additive ? env.glow : env.particles) ?? [];
      const count = Math.floor(list.length / PARTICLE_FLOATS);
      if (count === 0) return null;
      if (particle.pipeline < 0) {
        particle.pipeline = gpu.createPipeline({
          wgsl: PARTICLE_SHADER,
          stride: 8,
          attributes: [{ format: VertexFormat.Float32x2, offset: 0, location: 0 }],
          depth: true,
          depthWrite: false,
          blend: true,
          additive,
          instanceStride: PARTICLE_FLOATS * 4,
          instanceAttributes: [
            { format: VertexFormat.Float32x4, offset: 0, location: 1 },
            { format: VertexFormat.Float32x4, offset: 16, location: 2 },
          ],
        });
        particle.quad = gpu.createBuffer(BufferUsage.Vertex, f32Bytes(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1])));
        // Both windings, so back-face culling never drops the quad.
        particle.indices = gpu.createBuffer(BufferUsage.Index, u32Bytes(new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2])));
        particle.uniforms = gpu.createBuffer(BufferUsage.Uniform, f32Bytes(particleUniforms));
        particle.bindGroup = gpu.bind(particle.pipeline, particle.uniforms, -1);
      }
      let sorted: Float32Array;
      if (additive) sorted = new Float32Array(list.slice(0, count * PARTICLE_FLOATS));
      else {
        // Back to front from the eye, so blending composes the nearer ones over the farther.
        const order: number[] = [];
        const depth: number[] = [];
        for (let i = 0; i < count; i++) {
          const dx = list[i * PARTICLE_FLOATS] - camera.eye.x;
          const dy = list[i * PARTICLE_FLOATS + 1] - camera.eye.y;
          const dz = list[i * PARTICLE_FLOATS + 2] - camera.eye.z;
          order.push(i);
          depth.push(dx * dx + dy * dy + dz * dz);
        }
        order.sort((a: number, b: number): number => depth[b] - depth[a]);
        sorted = new Float32Array(count * PARTICLE_FLOATS);
        for (let i = 0; i < count; i++) for (let c = 0; c < PARTICLE_FLOATS; c++) sorted[i * PARTICLE_FLOATS + c] = list[order[i] * PARTICLE_FLOATS + c];
      }
      if (count > particle.capacity) {
        if (particle.instances >= 0) gpu.destroyBuffer(particle.instances);
        particle.capacity = Math.max(count, particle.capacity * 2, 256);
        particle.instances = gpu.createBuffer(BufferUsage.Vertex, f32Bytes(new Float32Array(particle.capacity * PARTICLE_FLOATS)));
      }
      gpu.writeBuffer(particle.instances, f32Bytes(sorted));
      particleUniforms.set(viewProjection, 0);
      // eye.w: 1 for additive, whose fog fades them to nothing instead of to the fog color.
      particleUniforms.set([camera.eye.x, camera.eye.y, camera.eye.z, additive ? 1 : 0, view[0], view[4], view[8], 0, view[1], view[5], view[9], 0], 16);
      const fog = env.fog;
      particleUniforms.set(fog ? [fog.color.x, fog.color.y, fog.color.z, fog.density] : [0, 0, 0, 0], 28);
      gpu.writeBuffer(particle.uniforms, f32Bytes(particleUniforms));
      return { pipeline: particle.pipeline, bindGroup: particle.bindGroup, vertexBuffer: particle.quad, indexBuffer: particle.indices, first: 0, count: 12, instanceBuffer: particle.instances, instances: count };
    };
  };
  const particleDraw = particleSet(false);
  const glowDraw = particleSet(true);

  // Sky: pipeline and uniform buffer made on first use; the bind group follows the moon texture.
  const sky = { pipeline: -1, uniforms: -1, bindGroup: -1, texture: -1 };
  const skyUniforms = new Float32Array(SKY_FLOATS);
  const skyDraw = (camera: Camera, view: Float32Array, env: Environment): Draw | null => {
    const s = env.sky;
    if (!s) return null;
    if (sky.pipeline < 0) {
      sky.pipeline = gpu.createPipeline({ wgsl: SKY_SHADER, stride: 0, attributes: [], depth: false, blend: false });
      sky.uniforms = gpu.createBuffer(BufferUsage.Uniform, f32Bytes(skyUniforms));
    }
    const texture = s.moon && s.moon.texture ? s.moon.texture.id : white.id;
    if (sky.texture !== texture) {
      sky.bindGroup = gpu.bind(sky.pipeline, sky.uniforms, texture);
      sky.texture = texture;
    }
    const tanY = Math.tan(camera.fovY / 2);
    const put = (slot: number, x: number, y: number, z: number, w: number): void => {
      skyUniforms[slot * 4] = x;
      skyUniforms[slot * 4 + 1] = y;
      skyUniforms[slot * 4 + 2] = z;
      skyUniforms[slot * 4 + 3] = w;
    };
    skyUniforms.fill(0);
    put(0, view[0], view[4], view[8], tanY * (camera.aspect ?? gpu.aspect()));
    put(1, view[1], view[5], view[9], tanY);
    put(2, -view[2], -view[6], -view[10], env.time ?? 0);
    put(3, s.zenith.x, s.zenith.y, s.zenith.z, env.exposure ?? 0);
    put(4, s.horizon.x, s.horizon.y, s.horizon.z, s.energy ?? 1);
    const ground = s.ground ?? vec3(s.horizon.x * 0.3, s.horizon.y * 0.3, s.horizon.z * 0.3);
    put(5, ground.x, ground.y, ground.z, s.curve ?? 0.15);
    if (s.sun) put(6, s.sun.direction.x, s.sun.direction.y, s.sun.direction.z, s.sun.size);
    put(7, s.sun ? s.sun.color.x : 0, s.sun ? s.sun.color.y : 0, s.sun ? s.sun.color.z : 0, s.stars ?? 0);
    if (s.moon) put(8, s.moon.direction.x, s.moon.direction.y, s.moon.direction.z, s.moon.size);
    put(9, s.moon ? s.moon.color.x : 0, s.moon ? s.moon.color.y : 0, s.moon ? s.moon.color.z : 0, s.milkyWay ?? 0);
    if (s.glow) {
      put(10, s.glow.direction.x, s.glow.direction.y, s.glow.direction.z, 0);
      put(11, s.glow.color.x, s.glow.color.y, s.glow.color.z, 1);
    }
    gpu.writeBuffer(sky.uniforms, f32Bytes(skyUniforms));
    return { pipeline: sky.pipeline, bindGroup: sky.bindGroup, vertexBuffer: -1, indexBuffer: -1, first: 0, count: 3 };
  };

  const draws = (world: World, gameCamera: Camera, environment?: Environment): Draw[] => {
    const forced = gameCamera.fixed ? null : cameraOverride.camera;
    const camera: Camera = forced ? { eye: forced.eye, target: forced.target, fovY: forced.fovY, near: gameCamera.near, far: gameCamera.far, layers: gameCamera.layers, aspect: gameCamera.aspect, roll: gameCamera.roll } : gameCamera;
    const cameraLayers = camera.layers ?? 1;
    const view = lookAt(camera.eye, camera.target, rolledUp(camera));
    const viewProjection = multiply(perspective(camera.fovY, camera.aspect ?? gpu.aspect(), camera.near ?? 0.1, camera.far ?? 100), view);
    writeScene(camera, environment ?? DEFAULT_ENVIRONMENT, viewProjection);
    const out: Draw[] = [];
    // First, in its own pass (no depth): everything after draws over it.
    const skyFirst = skyDraw(camera, view, environment ?? DEFAULT_ENVIRONMENT);
    if (skyFirst) out.push(skyFirst);
    const passes: { vp: Float32Array; squeeze: Float32Array; sun: number }[] = [];
    if (shadowVP) passes.push({ vp: shadowVP, squeeze: spotHalf, sun: 0 });
    if (sunVP) passes.push({ vp: sunVP, squeeze: sunHalf, sun: 1 });
    if (passes.length > 0) {
      // Shadow pass: static meshes seen from the spot and the sun, each into its half of the map (distance for the
      // spot, depth for the sun, packed into the color).
      const casters: Draw[] = [];
      for (const [entity, meshRef] of world.meshes) {
        const transform = world.transforms.get(entity);
        const mesh = meshes[meshRef.mesh];
        if (!transform || !mesh || mesh.skinned || meshRef.instances || (meshRef.emissive ?? 0) > 0 || ((meshRef.layers ?? 1) & 1) === 0) continue;
        const model = compose(transform.position, transform.rotation, transform.scale);
        for (const pass of passes) {
          const key = entityKey(world, entity) * 2 + pass.sun;
          let binding = shadowBindings.get(key);
          if (!binding) {
            const buffer = gpu.createBuffer(BufferUsage.Uniform, f32Bytes(shadowUniforms));
            binding = [buffer, gpu.bind(shadowPipeline, buffer, -1)];
            shadowBindings.set(key, binding);
          }
          shadowUniforms.set(multiply(pass.squeeze, multiply(pass.vp, model)), 0);
          shadowUniforms.set(model, 16);
          shadowUniforms[32] = pass.sun;
          shadowUniforms.set(scene, 40);
          gpu.writeBuffer(binding[0], f32Bytes(shadowUniforms));
          casters.push({ pipeline: shadowPipeline, bindGroup: binding[1], vertexBuffer: mesh.vertexBuffer, indexBuffer: mesh.indexBuffer, first: 0, count: mesh.count });
        }
      }
      gpu.frame({ r: 1, g: 1, b: 1 }, casters, shadowMap);
    }
    for (const [entity, meshRef] of world.meshes) {
      const transform = world.transforms.get(entity);
      const mesh = meshes[meshRef.mesh];
      if (!transform || !mesh || ((meshRef.layers ?? 1) & cameraLayers) === 0) continue;

      const texture = meshRef.texture ?? white;
      const instances = meshRef.instances;
      const kind = mesh.skinned ? 1 : instances ? 2 : 0;
      let entityPipeline = kind === 1 ? skinnedPipeline : kind === 2 ? instancedPipeline : pipeline;
      const material = meshRef.material;
      if (material !== undefined) {
        if (material < 0 || material >= materials.length) throw new Error(`MeshRef.material ${material}: no such material (Renderer.createMaterial)`);
        const key = material * 4 + kind;
        let custom = materialPipelines.get(key);
        if (custom === undefined) {
          custom = pipelineFor(kind, materials[material]);
          materialPipelines.set(key, custom);
        }
        entityPipeline = custom;
      }
      const data = mesh.skinned ? skinnedUniforms : uniforms;
      const bindingKey = entityKey(world, entity);
      let binding = bindings.get(bindingKey);
      if (!binding || binding.texture !== texture || binding.pipeline !== entityPipeline) {
        const uniformBuffer = binding?.uniformBuffer ?? gpu.createBuffer(BufferUsage.Uniform, f32Bytes(data));
        binding = { pipeline: entityPipeline, uniformBuffer, bindGroup: gpu.bind(entityPipeline, uniformBuffer, texture.id, shadowMap.id), texture };
        bindings.set(bindingKey, binding);
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
      uniforms[39] = meshRef.sway ?? 0;
      uniforms.set(scene, 40);
      // fog.w is the density; 0 skips fog in the fragment shader.
      if (meshRef.fog === false) {
        uniforms[47] = 0;
        uniforms[40 + FOG_SLOT] = 0;
        uniforms[40 + FOG_SLOT + 1] = 0;
      }
      const params = meshRef.params;
      if (params) for (let i = 0; i < Math.min(params.length, 8); i++) uniforms[PARAMS_SLOT + i] = params[i];
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

      if (instances && instances.cells.length > 0) {
        // One draw per cell in view; on mobile, far cells draw an even prefix of their instances.
        for (const cell of instances.cells) {
          const c = transformPoint(model, cell.center);
          const reach = cell.radius + mesh.radius * cell.scale;
          if (!inView(viewProjection, c, reach)) continue;
          let count = cell.count;
          if (gpu.mobile) {
            const d = Math.max(Math.hypot(c[0] - camera.eye.x, c[1] - camera.eye.y, c[2] - camera.eye.z) - cell.radius, 0.001);
            const ratio = (mesh.radius * cell.scale) / d / INSTANCE_DETAIL.size;
            if (ratio < 1) count = Math.max(1, Math.ceil(cell.count * Math.max(ratio * ratio, INSTANCE_DETAIL.floor)));
          }
          out.push({ pipeline: entityPipeline, bindGroup: binding.bindGroup, vertexBuffer: mesh.vertexBuffer, indexBuffer: mesh.indexBuffer, first: 0, count: mesh.count, instanceBuffer: instances.buffer, instances: count, firstInstance: cell.first });
        }
        continue;
      }
      out.push({
        pipeline: entityPipeline,
        bindGroup: binding.bindGroup,
        vertexBuffer: mesh.vertexBuffer,
        indexBuffer: mesh.indexBuffer,
        first: 0,
        count: mesh.count,
        instanceBuffer: instances ? instances.buffer : -1,
        instances: instances ? instances.count : 1,
      });
    }
    const particles = particleDraw(camera, viewProjection, view, environment ?? DEFAULT_ENVIRONMENT);
    if (particles) out.push(particles);
    const glow = glowDraw(camera, viewProjection, view, environment ?? DEFAULT_ENVIRONMENT);
    if (glow) out.push(glow);
    return out;
  };

  const render = (world: World, camera: Camera, clear: Color, environment?: Environment): void =>
    gpu.frame(clear, draws(world, camera, environment));

  return { addMesh, addSkinnedMesh, addInstances, updateInstances, draws, render, createMaterial };
}

function meshRadius(positions: Float32Array): number {
  let r = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) r = Math.max(r, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  return r;
}

// Instances reordered by ground cell (place.xyz in the first three floats, scale in the fourth), each cell's order
// shuffled with a fixed hash so a prefix samples the cell evenly. Cells are INSTANCE_CELL meters, widened so a set
// has at most about INSTANCE_CELLS of them (a forest across the map stays a few dozen draws).
export const INSTANCE_CELLS = 36;
export function splitCells(data: Float32Array): { data: Float32Array; cells: InstanceCell[] } {
  const count = Math.floor(data.length / INSTANCE_FLOATS);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < count; i++) {
    x0 = Math.min(x0, data[i * INSTANCE_FLOATS]);
    x1 = Math.max(x1, data[i * INSTANCE_FLOATS]);
    z0 = Math.min(z0, data[i * INSTANCE_FLOATS + 2]);
    z1 = Math.max(z1, data[i * INSTANCE_FLOATS + 2]);
  }
  const size = Math.max(INSTANCE_CELL, Math.max(x1 - x0, z1 - z0) / Math.sqrt(INSTANCE_CELLS));
  const groups = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_FLOATS;
    const key = `${Math.floor((data[o] - x0) / size)},${Math.floor((data[o + 2] - z0) / size)}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  const out = new Float32Array(count * INSTANCE_FLOATS);
  const cells: InstanceCell[] = [];
  let at = 0;
  for (const list of groups.values()) {
    let s = list.length * 2654435761;
    for (let i = list.length - 1; i > 0; i--) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const j = s % (i + 1);
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let scale = 0;
    list.forEach((index: number, k: number): void => {
      const o = index * INSTANCE_FLOATS;
      for (let f = 0; f < INSTANCE_FLOATS; f++) out[(at + k) * INSTANCE_FLOATS + f] = data[o + f];
      cx += data[o];
      cy += data[o + 1];
      cz += data[o + 2];
      scale = Math.max(scale, Math.abs(data[o + 3]));
    });
    const center: [number, number, number] = [cx / list.length, cy / list.length, cz / list.length];
    let radius = 0;
    for (const index of list) {
      const o = index * INSTANCE_FLOATS;
      radius = Math.max(radius, Math.hypot(data[o] - center[0], data[o + 1] - center[1], data[o + 2] - center[2]));
    }
    cells.push({ first: at, count: list.length, center, radius, scale });
    at += list.length;
  }
  return { data: out, cells };
}

function transformPoint(m: Float32Array, p: [number, number, number]): [number, number, number] {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

// The point lights a view draws, at most MAX_LIGHTS: unlit ones (no range or color) and ones whose reach is out of
// view are dropped; past the cap, those nearest the eye (by the distance to their reach) win, in the given order on
// ties. A scene can hand over every lantern and fire it has.
export function pickLights(lights: PointLight[], viewProjection: Float32Array, eye: Vec3): PointLight[] {
  const lit = lights.filter((l: PointLight): boolean => l.range > 0 && Math.max(l.color.x, l.color.y, l.color.z) > 0 && inView(viewProjection, [l.position.x, l.position.y, l.position.z], l.range));
  if (lit.length <= MAX_LIGHTS) return lit;
  const gap = (l: PointLight): number => Math.max(0, Math.hypot(l.position.x - eye.x, l.position.y - eye.y, l.position.z - eye.z) - l.range);
  return lit
    .map((l: PointLight, i: number): { l: PointLight; i: number; g: number } => ({ l, i, g: gap(l) }))
    .sort((a, b): number => a.g - b.g || a.i - b.i)
    .slice(0, MAX_LIGHTS)
    .sort((a, b): number => a.i - b.i)
    .map((e): PointLight => e.l);
}

// A sphere against the clip-space planes of a view-projection (WebGPU depth 0..1).
export function inView(vp: Float32Array, c: [number, number, number], r: number): boolean {
  const row = (i: number): number[] => [vp[i], vp[4 + i], vp[8 + i], vp[12 + i]];
  const x = row(0);
  const y = row(1);
  const z = row(2);
  const w = row(3);
  const planes = [
    [w[0] + x[0], w[1] + x[1], w[2] + x[2], w[3] + x[3]],
    [w[0] - x[0], w[1] - x[1], w[2] - x[2], w[3] - x[3]],
    [w[0] + y[0], w[1] + y[1], w[2] + y[2], w[3] + y[3]],
    [w[0] - y[0], w[1] - y[1], w[2] - y[2], w[3] - y[3]],
    [z[0], z[1], z[2], z[3]],
  ];
  for (const p of planes) {
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    if ((p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3]) / len < -r) return false;
  }
  return true;
}
