import { expect, test } from "bun:test";
import { restPose } from "../src/anim";
import type { GlbModel } from "../src/gltf";
import { createRig, qinv, qmul, qrotate, solve, twoBoneIk } from "../src/rig";

// A leg: the hip at the origin, the knee 1 up, the foot's tip bent forward of it (not a node, like glTF bones).
function leg(): GlbModel {
  const node = (name: string, parent: number, y: number) => ({ name, parent, translation: [0, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return { primitives: [], nodes: [node("Up", -1, 0), node("Low", 0, 1)], skins: [{ joints: [0, 1], inverseBindMatrices: new Float32Array(32) }], animations: [], materials: [], images: [], min: [0, 0, 0], max: [0, 2, 0] } as unknown as GlbModel;
}

test("twoBoneIk bends the leg so the foot reaches a point within its length", () => {
  const model = leg();
  const rest = restPose(model);
  const rig = createRig(model, rest);
  const pose = restPose(model);
  const foot0 = [0, 1.8, 0.5];
  const target = [0.6, 0.9, 0.7];
  twoBoneIk(rig, pose, 0, 1, foot0, target);
  solve(rig, pose);
  const knee = rig.pos[1];
  const tip = qrotate(qmul(rig.rot[1], qinv(rig.restRot[1])), [foot0[0] - 0, foot0[1] - 1, foot0[2] - 0]);
  const foot = [knee[0] + tip[0], knee[1] + tip[1], knee[2] + tip[2]];
  // The bones keep their lengths and the foot lands on the target.
  expect(Math.hypot(knee[0], knee[1], knee[2])).toBeCloseTo(1, 4);
  for (let a = 0; a < 3; a++) expect(foot[a]).toBeCloseTo(target[a], 3);
});
