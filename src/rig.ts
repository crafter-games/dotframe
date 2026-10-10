// A model's skeleton in model space, for posing by hand on top of (or instead of) clips: forward kinematics over a
// Pose's locals (createRig, solve), turning and aiming bones, a head look, a two-bone IK reach, a dry jerk, and points
// that follow a bone (a BoneAttachment3D). Ported from The Ones' npc_pose.gd, one_motion.gd and giant_tripod.gd
// through its dotframe port. The character faces +z.
import type { Pose } from "./anim";
import { datan2, dcos, dsin } from "./detmath";
import type { GlbModel } from "./gltf";
import { humanoidMap } from "./retarget";

export type V = number[];
export type Q = number[];

export const STRIDE = 10;

export const R = 3;

export const S = 7;

export const DEG = Math.PI / 180;

export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];

export const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const len = (a: V): number => Math.sqrt(dot(a, a));

export const norm = (a: V): V => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qinv = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
export const qnorm = (q: Q): Q => {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

export const qaxis = (axis: V, angle: number): Q => {
  const a = norm(axis);
  const s = dsin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, dcos(angle / 2)];
};

export const qrotate = (q: Q, v: V): V => {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q));
  return [r[0], r[1], r[2]];
};

// Shortest rotation taking unit a onto unit b (Godot's Quaternion(arc_from, arc_to)).
export function arc(a: V, b: V): Q {
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]];
    return qnorm([axis[0], axis[1], axis[2], 0]);
  }
  return qnorm([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d]);
}

export function slerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const c = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) return qnorm([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t, a[3] + (c[3] - a[3]) * t]);
  const th = datan2(Math.sqrt(1 - d * d), d);
  const sa = dsin((1 - t) * th) / dsin(th);
  const sb = dsin(t * th) / dsin(th);
  return [a[0] * sa + c[0] * sb, a[1] * sa + c[1] * sb, a[2] * sa + c[2] * sb, a[3] * sa + c[3] * sb];
}

export const smooth = (x: number): number => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

export interface Rig {
  model: GlbModel;
  map: Map<string, number>;
  // Head -> HeadTop length in model units (1.4 x the neck when there is no top bone).
  headLength: number;
  // Where the top of the head is at rest (HeadTop, or headLength above the head).
  headTop: V;
  // The hips, and the model's up axis in their parent's frame (CC3 rigs sit under a z-up armature).
  hips: number;
  hipsUp: V;
  // Model-space rotation, position and uniform scale of every node for the pose being edited.
  rot: Q[];
  pos: V[];
  scale: number[];
  // The same at rest, for things attached to a bone (Tetsuo's cap) that follow it from where they were placed.
  restRot: Q[];
  restPos: V[];
}

export function createRig(model: GlbModel, rest: Pose): Rig {
  const map = humanoidMap(model, 0);
  const rig: Rig = { model, map, headLength: 1, headTop: [0, 0, 0], hips: map.get("Hips") ?? -1, hipsUp: [0, 1, 0], rot: [], pos: [], scale: [], restRot: [], restPos: [] };
  solve(rig, rest);
  rig.restRot = rig.rot.slice();
  rig.restPos = rig.pos.slice();
  const parent = rig.hips >= 0 ? model.nodes[rig.hips].parent : -1;
  if (parent >= 0) rig.hipsUp = norm(qrotate(qinv(rig.rot[parent]), [0, 1, 0]));
  const head = map.get("Head");
  if (head !== undefined) {
    const top = model.nodes.findIndex((n) => n.parent === head && n.name.includes("Top"));
    const neck = map.get("Neck");
    if (top >= 0) rig.headLength = len(sub(rig.pos[top], rig.pos[head]));
    else if (neck !== undefined) rig.headLength = len(sub(rig.pos[head], rig.pos[neck])) * 1.4;
    rig.headTop = top >= 0 ? rig.pos[top] : add(rig.pos[head], [0, rig.headLength, 0]);
  }
  return rig;
}

// Forward kinematics over the pose's locals (parents come before children only by recursion, so resolve on demand).
export function solve(rig: Rig, pose: Pose): void {
  const nodes = rig.model.nodes;
  const done = new Uint8Array(nodes.length);
  const l = pose.locals;
  const resolve = (i: number): void => {
    if (done[i]) return;
    const o = i * STRIDE;
    const r: Q = [l[o + R], l[o + R + 1], l[o + R + 2], l[o + R + 3]];
    const p = nodes[i].parent;
    if (p < 0) {
      rig.rot[i] = r;
      rig.pos[i] = [l[o], l[o + 1], l[o + 2]];
      rig.scale[i] = l[o + S];
    } else {
      resolve(p);
      rig.rot[i] = qmul(rig.rot[p], r);
      rig.pos[i] = add(rig.pos[p], qrotate(rig.rot[p], mul([l[o], l[o + 1], l[o + 2]], rig.scale[p])));
      rig.scale[i] = rig.scale[p] * l[o + S];
    }
    done[i] = 1;
  };
  for (let i = 0; i < nodes.length; i++) resolve(i);
}

// Sets bone i's model-space rotation by writing its local one, then refreshes the chain below it.
export function setRot(rig: Rig, pose: Pose, i: number, q: Q): void {
  const p = rig.model.nodes[i].parent;
  const local = qnorm(p < 0 ? q : qmul(qinv(rig.rot[p]), q));
  pose.locals.set(local, i * STRIDE + R);
  solve(rig, pose);
}

// Rotates a bone about its own origin around a model-space axis.
export function turn(rig: Rig, pose: Pose, bone: string, axis: V, angle: number): void {
  const i = rig.map.get(bone);
  if (i === undefined || Math.abs(angle) < 1e-5) return;
  setRot(rig, pose, i, qmul(qaxis(axis, angle), rig.rot[i]));
}

// Turns a bone so it points (toward its child) along dir, blended by w.
export function aim(rig: Rig, pose: Pose, bone: string, child: string, dir: V, w: number): void {
  const i = rig.map.get(bone);
  const c = rig.map.get(child);
  if (i === undefined || c === undefined) return;
  const cur = sub(rig.pos[c], rig.pos[i]);
  if (len(cur) < 1e-6) return;
  const q = slerp([0, 0, 0, 1], arc(norm(cur), norm(dir)), w);
  setRot(rig, pose, i, qmul(q, rig.rot[i]));
}

// Character axes in model space: faces +z, right is -x, and a positive angle about lft bends forward.
export const FWD: V = [0, 0, 1];

export const UP: V = [0, 1, 0];

export const RIGHT: V = [-1, 0, 0];

export const LFT: V = [1, 0, 0];

export function headLook(rig: Rig, pose: Pose, target: V, weight: number): void {
  const hi = rig.map.get("Head");
  if (hi === undefined || weight <= 0.001) return;
  const v = sub(target, rig.pos[hi]);
  if (len(v) < 0.01) return;
  const d = norm(v);
  let yaw = datan2(-dot(d, RIGHT), dot(d, FWD));
  const up = Math.min(Math.max(dot(d, UP), -1), 1);
  let pitch = datan2(up, Math.sqrt(1 - up * up));
  // Behind: the neck does not twist, the body turns.
  if (Math.abs(yaw) > 110 * DEG) return;
  yaw = Math.min(Math.max(yaw, -70 * DEG), 70 * DEG) * weight;
  pitch = Math.min(Math.max(pitch, -35 * DEG), 35 * DEG) * weight;
  turn(rig, pose, "Neck", UP, yaw * 0.4);
  turn(rig, pose, "Head", UP, yaw * 0.6);
  turn(rig, pose, "Neck", RIGHT, pitch * 0.4);
  turn(rig, pose, "Head", RIGHT, pitch * 0.6);
}

// A point placed at rest relative to a bone, where it is in the current pose, and the rotation the bone added
// since rest (a BoneAttachment3D in Godot).
export function follow(rig: Rig, bone: number, restPoint: V): { pos: V; rot: Q } {
  const rot = qmul(rig.rot[bone], qinv(rig.restRot[bone]));
  return { pos: add(rig.pos[bone], qrotate(rot, sub(restPoint, rig.restPos[bone]))), rot };
}

export const turnBy = (q: Q, v: V): V => qrotate(q, v);

export const compose = qmul;

export const axisAngle = qaxis;

// Euler angles for Transform.rotation (compose() applies Ry * Rx * Rz).
export function eulerYXZ(q: Q): V {
  const [x, y, z, w] = q;
  const r02 = 2 * (x * z + w * y);
  const r12 = 2 * (y * z - w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const sx = Math.min(Math.max(-r12, -1), 1);
  return [datan2(sx, Math.sqrt(1 - sx * sx)), datan2(r02, r22), datan2(r10, r11)];
}

// root_lock.gd: the hips keep their rest position except along up, so the walk cycle walks in place and the
// routine moves the body. Horizontal in the model's space, not the bone's: under a z-up armature, local z is height.
export function lockRoot(rig: Rig, pose: Pose, rest: Pose): void {
  if (rig.hips < 0) return;
  const o = rig.hips * STRIDE;
  const base = [rest.locals[o], rest.locals[o + 1], rest.locals[o + 2]];
  const rise = dot(sub([pose.locals[o], pose.locals[o + 1], pose.locals[o + 2]], base), rig.hipsUp);
  pose.locals.set(add(base, mul(rig.hipsUp, rise)), o);
}

// one_motion.gd for the Ones: freeze_stare turns the neck and head toward a point while the body holds still (the
// head look's 70 and 35 degree limits stand in for stare_max 75), and snap is the dry jerk of twitch(): the neck by
// 0.45 of the amount and the head by all of it, around axis, scaled by s (1 at the jerk, eased back to 0).
export function stare(rig: Rig, pose: Pose, target: V, weight: number): void {
  headLook(rig, pose, target, weight);
}

export function snap(rig: Rig, pose: Pose, axis: V, degrees: number, s: number): void {
  turn(rig, pose, "Neck", axis, degrees * DEG * 0.45 * s);
  turn(rig, pose, "Head", axis, degrees * DEG * s);
}

// giant_tripod.gd _solve: a two-bone leg (up, then low under it) whose low bone ends at foot0 at rest, bent in its rest
// plane turned toward the target, reaching target (model space) as far as its length allows.
export function twoBoneIk(rig: Rig, pose: Pose, up: number, low: number, foot0: V, target: V): void {
  const h0 = rig.restPos[up];
  const k0 = rig.restPos[low];
  const a = len(sub(k0, h0));
  const b = len(sub(foot0, k0));
  const v = sub(target, h0);
  const d = Math.min(Math.max(len(v), Math.abs(a - b) + 0.01), a + b - 0.01);
  const dir = norm(v);
  const restDir = norm(sub(foot0, h0));
  const q = arc(restDir, dir);
  const kv = sub(k0, h0);
  // A leg straight at rest has no bend plane of its own: any side will do.
  const side = sub(kv, mul(restDir, dot(kv, restDir)));
  const n0 = len(side) > 1e-6 ? side : Math.abs(restDir[0]) < 0.9 ? [0, -restDir[2], restDir[1]] : [restDir[2], 0, -restDir[0]];
  const turned = qrotate(q, n0);
  const bend = norm(sub(turned, mul(dir, dot(turned, dir))));
  const along = (a * a - b * b + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(a * a - along * along, 0));
  const knee = add(add(h0, mul(dir, along)), mul(bend, hh));
  const foot = add(h0, mul(dir, d));
  setRot(rig, pose, up, qmul(arc(norm(kv), norm(sub(knee, h0))), rig.restRot[up]));
  setRot(rig, pose, low, qmul(arc(norm(sub(foot0, k0)), norm(sub(foot, knee))), rig.restRot[low]));
}
