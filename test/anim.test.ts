import { expect, test } from "bun:test";
import { jointMatrices, restPose, sampleAnimation, worldMatrices } from "../src/anim";
import type { GlbAnimation, GlbModel } from "../src/gltf";

// Two nodes: a root and a child one unit up. The skin uses the child with an identity inverse bind.
function model(): GlbModel {
  return {
    primitives: [],
    nodes: [
      { name: "root", parent: -1, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: "arm", parent: 0, translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
    skins: [{ joints: [1], inverseBind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }],
    animations: [],
    materials: [],
    images: [],
    min: [0, 0, 0],
    max: [0, 0, 0],
  };
}

const h = Math.SQRT1_2;
const clip: GlbAnimation = {
  name: "test",
  duration: 2,
  channels: [
    { node: 0, path: "translation", interpolation: "LINEAR", times: new Float32Array([0, 2]), values: new Float32Array([0, 0, 0, 4, 0, 0]) },
    // A quarter turn about y, keyed with the second quaternion negated: slerp must take the short way.
    { node: 0, path: "rotation", interpolation: "LINEAR", times: new Float32Array([0, 2]), values: new Float32Array([0, 0, 0, 1, 0, -h, 0, -h]) },
    { node: 1, path: "scale", interpolation: "STEP", times: new Float32Array([0, 1]), values: new Float32Array([1, 1, 1, 3, 3, 3]) },
  ],
};

const round = (v: ArrayLike<number>): number[] => Array.from(v).map((x) => Math.round(x * 1000) / 1000 + 0);

test("samples linear translation, short-way slerp and step scale", () => {
  const m = model();
  const pose = restPose(m);
  sampleAnimation(pose, clip, 1, false);
  expect(round(pose.locals.subarray(0, 3))).toEqual([2, 0, 0]);
  // Halfway through a quarter turn is an eighth turn, whichever sign the keys use.
  const q = round(pose.locals.subarray(3, 7));
  expect(Math.abs(q[1])).toBeCloseTo(Math.sin(Math.PI / 8), 3);
  expect(Math.abs(q[3])).toBeCloseTo(Math.cos(Math.PI / 8), 3);
  expect(round(pose.locals.subarray(17, 20))).toEqual([3, 3, 3]);
  sampleAnimation(pose, clip, 0.99, false);
  expect(round(pose.locals.subarray(17, 20))).toEqual([1, 1, 1]);
});

test("loops past the end and clamps without loop", () => {
  const m = model();
  const pose = restPose(m);
  sampleAnimation(pose, clip, 3, true);
  expect(round(pose.locals.subarray(0, 3))).toEqual([2, 0, 0]);
  sampleAnimation(pose, clip, 3, false);
  expect(round(pose.locals.subarray(0, 3))).toEqual([4, 0, 0]);
});

test("a weight below 1 blends from the current pose (crossfade)", () => {
  const m = model();
  const pose = restPose(m);
  sampleAnimation(pose, clip, 2, false, 0.25);
  expect(round(pose.locals.subarray(0, 3))).toEqual([1, 0, 0]);
});

test("joint matrices compose parents: the child follows the root's translation", () => {
  const m = model();
  const pose = restPose(m);
  sampleAnimation(pose, { ...clip, channels: [clip.channels[0]] }, 2, false);
  const worlds = worldMatrices(m, pose);
  expect(round(worlds.subarray(28, 31))).toEqual([4, 1, 0]);
  const joints = jointMatrices(m, pose, 0);
  expect(round(joints.subarray(12, 15))).toEqual([4, 1, 0]);
});
