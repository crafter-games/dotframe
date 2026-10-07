// Places a model loaded with loadGlb in an ECS world: one entity per primitive, sharing one transform.
import { type MeshRef, spawn, type World } from "./ecs";
import type { GlbModel } from "./gltf";
import type { Texture } from "./gpu";
import { type Vec3, vec3 } from "./math";
import type { Renderer } from "./render";

export interface ModelMeshes {
  // One renderer mesh per primitive, in GlbModel.primitives order.
  meshes: number[];
}

// Uploads every primitive once; spawn the result as many times as needed.
export function uploadModel(renderer: Renderer, model: GlbModel): ModelMeshes {
  return { meshes: model.primitives.map((p) => renderer.addMesh(p.mesh)) };
}

// Uniform scale that makes the model this tall, as Godot's fit-to-height placement does.
export function fitHeight(model: GlbModel, height: number): number {
  return height / Math.max(model.max[1] - model.min[1], 1e-6);
}

export interface Placement {
  position: Vec3;
  // Euler radians, as Transform.rotation.
  rotation: Vec3;
  scale: number;
  // Moves the model so its bounds sit on the position: centered on x and z, bottom at y. Default true.
  ground?: boolean;
}

// textures[i] is the decoded GlbModel.images[i], or undefined while it loads (the base color shows).
export function spawnModel(world: World, model: GlbModel, uploaded: ModelMeshes, textures: (Texture | undefined)[], placement: Placement): number[] {
  const s = placement.scale;
  const ground = placement.ground ?? true;
  // The ground offset is in model space, so it is rotated with the model by baking it into each entity's mesh
  // origin: entities share the transform, and the offset is applied before rotation through the pivot below.
  const cx = ground ? (model.min[0] + model.max[0]) / 2 : 0;
  const cy = ground ? model.min[1] : 0;
  const cz = ground ? (model.min[2] + model.max[2]) / 2 : 0;
  const ry = placement.rotation.y;
  const ox = (Math.cos(ry) * cx + Math.sin(ry) * cz) * s;
  const oz = (-Math.sin(ry) * cx + Math.cos(ry) * cz) * s;
  const position = vec3(placement.position.x - ox, placement.position.y - cy * s, placement.position.z - oz);
  const entities: number[] = [];
  model.primitives.forEach((p, i: number): void => {
    const entity = spawn(world);
    world.transforms.set(entity, { position, rotation: placement.rotation, scale: vec3(s, s, s) });
    const material = p.material >= 0 ? model.materials[p.material] : undefined;
    const ref: MeshRef = { mesh: uploaded.meshes[i], color: material ? vec3(material.color[0], material.color[1], material.color[2]) : vec3(1, 1, 1) };
    if (material && material.image >= 0) ref.texture = textures[material.image];
    if (material && material.alphaMode !== "OPAQUE") ref.alphaCutoff = material.alphaCutoff;
    world.meshes.set(entity, ref);
    entities.push(entity);
  });
  return entities;
}

// Sets each primitive's texture once the model's images are decoded (spawnModel may run before they load).
export function applyTextures(world: World, model: GlbModel, entities: number[], textures: (Texture | undefined)[]): void {
  model.primitives.forEach((p, i: number): void => {
    const ref = world.meshes.get(entities[i]);
    const material = p.material >= 0 ? model.materials[p.material] : undefined;
    if (ref && material && material.image >= 0) ref.texture = textures[material.image];
  });
}
