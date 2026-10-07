// Humanoid retargeting between Mixamo, Quaternius UAL and Character Creator 3 skeletons, ported from The Ones'
// npc_retarget.gd. Works in model space: each mapped bone's rotation away from its rest pose in the source is
// applied to the matching bone of the target, corrected for the difference between their rest poses (T-pose
// against A-pose) so both point the same way at rest. The hips move scaled by hip height. Unmapped bones keep
// their rest pose.
import { restPose, sampleAnimation, worldMatrices } from "./anim";
import type { GlbAnimation, GlbChannel, GlbModel } from "./gltf";

// Humanoid name -> [Mixamo, UAL, CC3] bone names.
// string[][] rather than tuples: scriptc only indexes tuples with literal indices, and humanoidMap picks the column at run time.
const HUMANOID: string[][] = [
  ["Hips", "Hips", "pelvis", "Hip"],
  ["Spine", "Spine", "spine_01", "Waist"],
  ["Chest", "Spine1", "spine_02", "Spine01"],
  ["UpperChest", "Spine2", "spine_03", "Spine02"],
  ["Neck", "Neck", "neck_01", "NeckTwist01"],
  ["Head", "Head", "Head", "Head"],
  ["LeftShoulder", "LeftShoulder", "clavicle_l", "L_Clavicle"],
  ["LeftUpperArm", "LeftArm", "upperarm_l", "L_Upperarm"],
  ["LeftLowerArm", "LeftForeArm", "lowerarm_l", "L_Forearm"],
  ["LeftHand", "LeftHand", "hand_l", "L_Hand"],
  ["RightShoulder", "RightShoulder", "clavicle_r", "R_Clavicle"],
  ["RightUpperArm", "RightArm", "upperarm_r", "R_Upperarm"],
  ["RightLowerArm", "RightForeArm", "lowerarm_r", "R_Forearm"],
  ["RightHand", "RightHand", "hand_r", "R_Hand"],
  ["LeftUpperLeg", "LeftUpLeg", "thigh_l", "L_Thigh"],
  ["LeftLowerLeg", "LeftLeg", "calf_l", "L_Calf"],
  ["LeftFoot", "LeftFoot", "foot_l", "L_Foot"],
  ["LeftToes", "LeftToeBase", "ball_l", "L_ToeBase"],
  ["RightUpperLeg", "RightUpLeg", "thigh_r", "R_Thigh"],
  ["RightLowerLeg", "RightLeg", "calf_r", "R_Calf"],
  ["RightFoot", "RightFoot", "foot_r", "R_Foot"],
  ["RightToes", "RightToeBase", "ball_r", "R_ToeBase"],
];
// Finger -> [Mixamo, UAL, CC3] part of the bone name.
const FINGERS: string[][] = [
  ["Thumb", "Thumb", "thumb", "Thumb"],
  ["Index", "Index", "index", "Index"],
  ["Middle", "Middle", "middle", "Mid"],
  ["Ring", "Ring", "ring", "Ring"],
  ["Little", "Pinky", "pinky", "Pinky"],
];
// Bone -> the child whose direction defines it (for the rest correction).
const AIM_CHILD: [string, string][] = [
  ["Hips", "Spine"],
  ["Spine", "Chest"],
  ["Chest", "UpperChest"],
  ["UpperChest", "Neck"],
  ["Neck", "Head"],
  ["LeftShoulder", "LeftUpperArm"],
  ["LeftUpperArm", "LeftLowerArm"],
  ["LeftLowerArm", "LeftHand"],
  ["LeftHand", "LeftMiddle1"],
  ["RightShoulder", "RightUpperArm"],
  ["RightUpperArm", "RightLowerArm"],
  ["RightLowerArm", "RightHand"],
  ["RightHand", "RightMiddle1"],
  ["LeftUpperLeg", "LeftLowerLeg"],
  ["LeftLowerLeg", "LeftFoot"],
  ["LeftFoot", "LeftToes"],
  ["RightUpperLeg", "RightLowerLeg"],
  ["RightLowerLeg", "RightFoot"],
  ["RightFoot", "RightToes"],
];

// "mixamorig:LeftArm_09" -> "LeftArm", "CC_Base_L_Hand_057" -> "L_Hand".
export function cleanBoneName(name: string): string {
  return stripPrefix(name.replace(/_\d+$/, ""));
}

function stripPrefix(name: string): string {
  for (const prefix of ["mixamorig:", "mixamorig_", "CC_Base_"]) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

// Humanoid name -> node index, for the joints of one skin.
export function humanoidMap(model: GlbModel, skin: number): Map<string, number> {
  const byClean = new Map<string, number>();
  // Both spellings: UAL's "spine_01" is a real name, Sketchfab's "_09" on "mixamorig:LeftArm_09" is an export suffix.
  for (const joint of model.skins[skin].joints) {
    const raw = stripPrefix(model.nodes[joint].name);
    if (!byClean.has(raw)) byClean.set(raw, joint);
    const clean = cleanBoneName(model.nodes[joint].name);
    if (!byClean.has(clean)) byClean.set(clean, joint);
  }
  const kind = byClean.has("pelvis") ? 2 : byClean.has("Hip") && byClean.has("Waist") ? 3 : 1;
  const out = new Map<string, number>();
  for (const h of HUMANOID) {
    const node = byClean.get(h[kind]);
    if (node !== undefined) out.set(h[0], node);
  }
  for (const side of ["Left", "Right"]) {
    for (const f of FINGERS) {
      for (let j = 1; j <= 3; j++) {
        const part = f[kind];
        const name = kind === 1 ? `${side}Hand${part}${j}` : kind === 2 ? `${part}_0${j}_${side === "Left" ? "l" : "r"}` : `${side === "Left" ? "L" : "R"}_${part}${j}`;
        const node = byClean.get(name);
        if (node !== undefined) out.set(`${side}${f[0]}${j}`, node);
      }
    }
  }
  return out;
}

type Quat = [number, number, number, number];

const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
// Shortest rotation taking unit vector a onto unit vector b (Godot's Quaternion(arc_from, arc_to)).
function arc(a: number[], b: number[]): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]];
    return qnorm([axis[0], axis[1], axis[2], 0]);
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

// Rotation of a world matrix with its scale removed.
function matrixRotation(m: Float32Array, o: number): Quat {
  const sx = Math.hypot(m[o], m[o + 1], m[o + 2]) || 1;
  const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]) || 1;
  const sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]) || 1;
  const r00 = m[o] / sx;
  const r10 = m[o + 1] / sx;
  const r20 = m[o + 2] / sx;
  const r01 = m[o + 4] / sy;
  const r11 = m[o + 5] / sy;
  const r21 = m[o + 6] / sy;
  const r02 = m[o + 8] / sz;
  const r12 = m[o + 9] / sz;
  const r22 = m[o + 10] / sz;
  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return qnorm([(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4]);
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    return qnorm([s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s]);
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    return qnorm([(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s]);
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
  return qnorm([(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s]);
}

const origin = (m: Float32Array, node: number): number[] => [m[node * 16 + 12], m[node * 16 + 13], m[node * 16 + 14]];

// Applies the inverse of the linear part (rotation and scale) of a column-major matrix to a vector.
function inverseLinear(m: Float32Array, o: number, v: number[]): number[] {
  const a = m[o], b = m[o + 4], c = m[o + 8];
  const d = m[o + 1], e = m[o + 5], f = m[o + 9];
  const g = m[o + 2], h = m[o + 6], i = m[o + 10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1;
  return [
    ((e * i - f * h) * v[0] + (c * h - b * i) * v[1] + (b * f - c * e) * v[2]) / det,
    ((f * g - d * i) * v[0] + (a * i - c * g) * v[1] + (c * d - a * f) * v[2]) / det,
    ((d * h - e * g) * v[0] + (b * g - a * h) * v[1] + (a * e - b * d) * v[2]) / det,
  ];
}

export interface RetargetOptions {
  // Samples per second of the output clip. Default 30, as npc_retarget.gd.
  fps?: number;
  // Keep the hips' horizontal motion (root motion). Default false: the caller moves the character.
  keepHipsXZ?: boolean;
  // Name of the output clip; default the source's.
  name?: string;
}

// Retargets clip (animating source's skin sourceSkin) onto target's skin targetSkin. The result animates target's
// nodes and plays with sampleAnimation on a pose of target.
export function retarget(source: GlbModel, sourceSkin: number, clip: GlbAnimation, target: GlbModel, targetSkin: number, options: RetargetOptions = {}): GlbAnimation {
  const fps = options.fps ?? 30;
  const sm = humanoidMap(source, sourceSkin);
  const dm = humanoidMap(target, targetSkin);
  const sRest = worldMatrices(source, restPose(source));
  const dRest = worldMatrices(target, restPose(target));
  const rot = (m: Float32Array, node: number): Quat => matrixRotation(m, node * 16);

  const aim = new Map<string, string>(AIM_CHILD);
  const corrections = new Map<number, Quat>();
  const pairs: { human: string; s: number; d: number }[] = [];
  for (const [human, d] of dm) {
    const s = sm.get(human);
    if (s === undefined) continue;
    let corr: Quat = [0, 0, 0, 1];
    const child = aim.get(human);
    const sc = child ? sm.get(child) : undefined;
    const dc = child ? dm.get(child) : undefined;
    if (sc !== undefined && dc !== undefined) {
      const sd = origin(sRest, sc).map((v, i) => v - origin(sRest, s)[i]);
      const dd = origin(dRest, dc).map((v, i) => v - origin(dRest, d)[i]);
      const sl = Math.hypot(sd[0], sd[1], sd[2]);
      const dl = Math.hypot(dd[0], dd[1], dd[2]);
      if (sl > 1e-5 && dl > 1e-5) corr = arc(dd.map((v) => v / dl), sd.map((v) => v / sl));
      corrections.set(d, corr);
    }
    pairs.push({ human, s, d });
  }
  // Fingers and the head, with no aim child, inherit the correction of the nearest mapped ancestor.
  for (const p of pairs) {
    if (corrections.has(p.d)) continue;
    let parent = target.nodes[p.d].parent;
    while (parent >= 0 && !corrections.has(parent)) parent = target.nodes[parent].parent;
    corrections.set(p.d, parent >= 0 ? (corrections.get(parent) ?? [0, 0, 0, 1]) : [0, 0, 0, 1]);
  }
  const mapped = new Map<number, number>();
  for (const p of pairs) mapped.set(p.d, p.s);

  const hipsS = sm.get("Hips");
  const hipsD = dm.get("Hips");
  const footS = sm.get("LeftFoot");
  const footD = dm.get("LeftFoot");
  let hipRatio = 1;
  if (hipsS !== undefined && hipsD !== undefined && footS !== undefined && footD !== undefined) {
    const hs = origin(sRest, hipsS)[1] - origin(sRest, footS)[1];
    const hd = origin(dRest, hipsD)[1] - origin(dRest, footD)[1];
    if (Math.abs(hs) > 1e-5) hipRatio = hd / hs;
  }

  // Parents before children.
  const order: number[] = [];
  const visited = new Uint8Array(target.nodes.length);
  const push = (n: number): void => {
    if (visited[n]) return;
    const parent = target.nodes[n].parent;
    if (parent >= 0) push(parent);
    visited[n] = 1;
    order.push(n);
  };
  for (let n = 0; n < target.nodes.length; n++) push(n);

  const frames = Math.max(1, Math.ceil(clip.duration * fps));
  const times = new Float32Array(frames + 1);
  const rotations = new Map<number, Float32Array>();
  for (const p of pairs) rotations.set(p.d, new Float32Array((frames + 1) * 4));
  const hipsT = new Float32Array((frames + 1) * 3);
  const pose = restPose(source);
  const dGlob: Quat[] = target.nodes.map((): Quat => [0, 0, 0, 1]);

  for (let f = 0; f <= frames; f++) {
    const t = Math.min(f / fps, clip.duration);
    times[f] = t;
    pose.locals.set(restPose(source).locals);
    sampleAnimation(pose, clip, t, false);
    const sNow = worldMatrices(source, pose);
    for (const n of order) {
      const parent = target.nodes[n].parent;
      const parentGlob: Quat = parent >= 0 ? dGlob[parent] : [0, 0, 0, 1];
      const s = mapped.get(n);
      if (s !== undefined) {
        const delta = qmul(rot(sNow, s), qinv(rot(sRest, s)));
        const g = qnorm(qmul(qmul(delta, corrections.get(n) ?? [0, 0, 0, 1]), rot(dRest, n)));
        dGlob[n] = g;
        const local = qnorm(qmul(qinv(parentGlob), g));
        rotations.get(n)?.set(local, f * 4);
      } else {
        // Unmapped nodes keep their rest: their world rotation follows the (possibly animated) parent.
        const r = target.nodes[n].rotation;
        dGlob[n] = qnorm(qmul(parentGlob, [r[0], r[1], r[2], r[3]]));
      }
    }
    if (hipsS !== undefined && hipsD !== undefined) {
      const off = origin(sNow, hipsS).map((v, i) => (v - origin(sRest, hipsS)[i]) * hipRatio);
      if (!options.keepHipsXZ) {
        off[0] = 0;
        off[2] = 0;
      }
      const parent = target.nodes[hipsD].parent;
      const local = parent >= 0 ? inverseLinear(dRest, parent * 16, off) : off;
      const rest = target.nodes[hipsD].translation;
      hipsT.set([rest[0] + local[0], rest[1] + local[1], rest[2] + local[2]], f * 3);
    }
  }

  const channels: GlbChannel[] = [];
  for (const p of pairs) channels.push({ node: p.d, path: "rotation", interpolation: "LINEAR", times, values: rotations.get(p.d) ?? new Float32Array(0) });
  if (hipsD !== undefined && hipsS !== undefined) channels.push({ node: hipsD, path: "translation", interpolation: "LINEAR", times, values: hipsT });
  return { name: options.name ?? clip.name, duration: clip.duration, channels };
}
