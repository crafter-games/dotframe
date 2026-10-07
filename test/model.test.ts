import { expect, test } from "bun:test";
import { createWorld, spawn } from "../src/ecs";
import type { GlbModel } from "../src/gltf";
import { placeModel } from "../src/model";
import { vec3 } from "../src/math";

test("placeModel moves every primitive of a model, not only the first", () => {
  const world = createWorld();
  const entities = [spawn(world), spawn(world)];
  const model = { min: [-1, 0, -1], max: [1, 2, 1] } as unknown as GlbModel;
  placeModel(world, model, entities, { position: vec3(5, 1, -3), rotation: vec3(0, 0.5, 0), scale: 2 });
  for (const e of entities) expect(world.transforms.get(e)).toMatchObject({ position: { x: 5, y: 1, z: -3 }, rotation: { y: 0.5 }, scale: { x: 2 } });
});
