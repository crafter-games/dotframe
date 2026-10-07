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
  // Sampled in world space on the three axes (triplanar), so boxes and terrain need no UVs. Tinted by color.
  texture?: Texture;
  // World units per texture repeat; defaults to 1.
  tile?: number;
  // Adds color * emissive unlit, for bulbs, lamps and the moon.
  emissive?: number;
}

export interface World {
  nextEntity: number;
  transforms: Map<number, Transform>;
  meshes: Map<number, MeshRef>;
}

export function createWorld(): World {
  return { nextEntity: 0, transforms: new Map<number, Transform>(), meshes: new Map<number, MeshRef>() };
}

export function spawn(world: World): number {
  const entity = world.nextEntity;
  world.nextEntity = entity + 1;
  return entity;
}
