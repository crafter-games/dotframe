// Places a model loaded with loadGlb in an ECS world: one entity per primitive, sharing one transform.
import { jointMatrices, type Pose } from "./anim";
import { type MeshRef, spawn, type World } from "./ecs";
import type { GlbModel } from "./gltf";
import type { Texture } from "./gpu";
import { type Vec3, vec3 } from "./math";
import type { Renderer } from "./render";

export interface ModelMeshes {
  // One renderer mesh per primitive, in GlbModel.primitives order.
  meshes: number[];
  // True where the mesh is GPU-skinned and needs poseModel() before it draws right.
  skinned: boolean[];
}

// Uploads every primitive once; spawn the result as many times as needed. With animate, skinned primitives are
// uploaded for GPU skinning; without it they draw at rest from the baked mesh.
export function uploadModel(renderer: Renderer, model: GlbModel, animate = false): ModelMeshes {
  const meshes: number[] = [];
  const skinned: boolean[] = [];
  for (const p of model.primitives) {
    const skin = animate ? p.skinned : undefined;
    meshes.push(skin ? renderer.addSkinnedMesh(p.mesh, skin) : renderer.addMesh(p.mesh));
    skinned.push(skin !== undefined);
  }
  return { meshes, skinned };
}

// Sets the joint matrices of every skinned primitive of one spawned model from pose.
export function poseModel(world: World, model: GlbModel, uploaded: ModelMeshes, entities: number[], pose: Pose): void {
  // One computation per skin; an empty array marks a skin not computed yet (scriptc has no Map<number, T>.get).
  const bySkin: Float32Array[] = model.skins.map((): Float32Array => new Float32Array(0));
  model.primitives.forEach((p, i: number): void => {
    if (!uploaded.skinned[i] || !p.skinned) return;
    const ref = world.meshes.get(entities[i]);
    if (!ref) return;
    const skin = p.skinned.skin;
    if (bySkin[skin].length === 0) bySkin[skin] = jointMatrices(model, pose, skin, ref.joints);
    ref.joints = bySkin[skin];
  });
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
  const entities: number[] = [];
  model.primitives.forEach((p, i: number): void => {
    const entity = spawn(world);
    const material = p.material >= 0 ? model.materials[p.material] : undefined;
    const ref: MeshRef = { mesh: uploaded.meshes[i], color: material ? vec3(material.color[0], material.color[1], material.color[2]) : vec3(1, 1, 1) };
    if (material && material.image >= 0) ref.texture = textures[material.image];
    if (material && material.alphaMode !== "OPAQUE") ref.alphaCutoff = material.alphaCutoff;
    world.meshes.set(entity, ref);
    entities.push(entity);
  });
  placeModel(world, model, entities, placement);
  return entities;
}

// Moves a spawned model: every primitive's entity gets the same transform, so a model with several primitives
// (a body and a dress) moves as one. Call it each frame for a model that walks.
export function placeModel(world: World, model: GlbModel, entities: number[], placement: Placement): void {
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
  for (const entity of entities) world.transforms.set(entity, { position, rotation: placement.rotation, scale: vec3(s, s, s) });
}

// Sets each primitive's texture once the model's images are decoded (spawnModel may run before they load).
export function applyTextures(world: World, model: GlbModel, entities: number[], textures: (Texture | undefined)[]): void {
  model.primitives.forEach((p, i: number): void => {
    const ref = world.meshes.get(entities[i]);
    const material = p.material >= 0 ? model.materials[p.material] : undefined;
    if (ref && material && material.image >= 0) ref.texture = textures[material.image];
  });
}
