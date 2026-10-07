import { expect, test } from "bun:test";
import { restPose, sampleAnimation } from "../src/anim";
import type { GlbAnimation, GlbModel } from "../src/gltf";
import { cleanBoneName, humanoidMap, retarget } from "../src/retarget";

// A three-bone spine: hips, spine, chest, one unit apart, named per skeleton family.
function spine(names: [string, string, string], scale: number): GlbModel {
  const id = new Float32Array(16 * 3);
  for (let j = 0; j < 3; j++) [0, 5, 10, 15].forEach((k) => (id[j * 16 + k] = 1));
  return {
    primitives: [],
    nodes: [
      { name: names[0], parent: -1, translation: [0, scale, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: names[1], parent: 0, translation: [0, scale, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: names[2], parent: 1, translation: [0, scale, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
    skins: [{ joints: [0, 1, 2], inverseBind: id }],
    animations: [],
    materials: [],
    images: [],
    min: [0, 0, 0],
    max: [0, 0, 0],
  };
}

const h = Math.SQRT1_2;
// The source bends its spine a quarter turn about z over one second.
const bend: GlbAnimation = { name: "bend", duration: 1, channels: [{ node: 1, path: "rotation", interpolation: "LINEAR", times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0, h, h]) }] };

test("bone names map across Mixamo (with Sketchfab suffixes) and UAL", () => {
  expect(cleanBoneName("mixamorig:LeftArm_09")).toBe("LeftArm");
  const mixamo = humanoidMap(spine(["mixamorig:Hips_01", "mixamorig:Spine_02", "mixamorig:Spine1_03"], 1), 0);
  const ual = humanoidMap(spine(["pelvis", "spine_01", "spine_02"], 1), 0);
  expect([...mixamo.entries()]).toEqual([["Hips", 0], ["Spine", 1], ["Chest", 2]]);
  expect([...ual.entries()]).toEqual([["Hips", 0], ["Spine", 1], ["Chest", 2]]);
});

test("a UAL clip drives the matching Mixamo bone, at a different scale", () => {
  const source = spine(["pelvis", "spine_01", "spine_02"], 1);
  const target = spine(["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1"], 0.01);
  const clip = retarget(source, 0, bend, target, 0);
  const pose = restPose(target);
  sampleAnimation(pose, clip, 1, false);
  const q = Array.from(pose.locals.subarray(13, 17)).map((v) => Math.round(Math.abs(v) * 1000) / 1000);
  expect(q).toEqual([0, 0, Math.round(h * 1000) / 1000, Math.round(h * 1000) / 1000]);
  // The chest is mapped too and stays at rest relative to its parent.
  const chest = Array.from(pose.locals.subarray(23, 27)).map((v) => Math.round(Math.abs(v) * 1000) / 1000);
  expect(chest).toEqual([0, 0, 0, 1]);
});
