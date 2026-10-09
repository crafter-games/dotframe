import type { Texture } from "./gpu";
import type { Vec3 } from "./math";

// Minimal ECS: entities are numbers, each component kind lives in its own Map.

export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface MeshRef {
  mesh: number;
  color: Vec3;
  // UV-mapped, or sampled in world space on the three axes (triplanar) when the mesh has no UVs. Tinted by color.
  // Load tiled textures with mipmaps (createImage(bytes, true, true)): the sampler then repeats them.
  texture?: Texture;
  // World units per texture repeat; defaults to 1.
  tile?: number;
  // Adds the surface color (texture times color) times emissive, unlit: bulbs, lamps, a lit paper lantern.
  emissive?: number;
  // Texels with alpha below this are discarded (glTF alphaMode MASK: leaves, fences, paper). 0 keeps every texel.
  alphaCutoff?: number;
  // Forces world-space triplanar mapping on a UV-mapped mesh. Meshes without UVs are always triplanar.
  triplanar?: boolean;
  // Joint matrices (16 floats per joint, from anim.jointMatrices) for a mesh added with addSkinnedMesh.
  joints?: Float32Array;
  // Draws the mesh once per instance (Renderer.addInstances), placed inside this entity's transform.
  instances?: Instances;
  // Wind: instanced vertices bend by this much per unit of height, animated by Environment.time.
  sway?: number;
  // false draws the mesh without Environment.fog: far lights and signs that must read through it (Godot disable_fog).
  fog?: boolean;
  // Render layers the mesh is on, a bitmask (default 1). A camera draws it when they share a layer (Camera.layers).
  // A mesh off layer 1 casts no shadow, so a mesh only one camera sees is not given away by its shadow.
  layers?: number;
  // A custom material (Renderer.createMaterial) in place of the built-in surface; tex, tile and alphaCutoff are then
  // the material's to use. params are up to eight floats it reads as SurfaceIn.params0 and params1.
  material?: number;
  params?: number[];
}

export interface Instances {
  buffer: number;
  count: number;
  // Ground cells over the buffer, which addInstances reorders cell by cell, each cell shuffled so any prefix is an
  // even sample: the renderer skips cells outside the view and, on mobile, draws a prefix of the far ones.
  cells: InstanceCell[];
}

export interface InstanceCell {
  // Range in the set's buffer.
  first: number;
  count: number;
  center: [number, number, number];
  // Farthest instance from center, and the largest instance scale.
  radius: number;
  scale: number;
}

export interface World {
  // Distinguishes worlds drawn by one renderer (its per-entity GPU buffers are keyed by world and entity).
  id?: number;
  nextEntity: number;
  transforms: Map<number, Transform>;
  meshes: Map<number, MeshRef>;
}

let nextWorld = 0;

export function createWorld(): World {
  return { id: nextWorld++, nextEntity: 0, transforms: new Map<number, Transform>(), meshes: new Map<number, MeshRef>() };
}

export function spawn(world: World): number {
  const entity = world.nextEntity;
  world.nextEntity = entity + 1;
  return entity;
}
