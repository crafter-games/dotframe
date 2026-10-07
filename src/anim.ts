// Skeletal animation for models loaded with loadGlb: a Pose holds every node's local transform, clips are sampled
// into it (with a weight, for crossfades), and jointMatrices() turns it into the matrices the skinned renderer
// needs. Presentation only: drive it from simulation time in render, never store a Pose in simulation state.
import type { GlbAnimation, GlbChannel, GlbModel } from "./gltf";

export interface Pose {
  // Per node: translation (3), rotation quaternion (4), scale (3), 10 floats each.
  locals: Float32Array;
}

const T = 0;
const R = 3;
const S = 7;
const STRIDE = 10;

export function restPose(model: GlbModel): Pose {
  const locals = new Float32Array(model.nodes.length * STRIDE);
  model.nodes.forEach((n, i: number): void => {
    locals.set(n.translation, i * STRIDE + T);
    locals.set(n.rotation, i * STRIDE + R);
    locals.set(n.scale, i * STRIDE + S);
  });
  return { locals };
}

export function findAnimation(model: GlbModel, name: string): GlbAnimation | undefined {
  for (const a of model.animations) if (a.name === name) return a;
  return undefined;
}

function sampleChannel(channel: GlbChannel, time: number, width: number, out: Float32Array): void {
  const times = channel.times;
  const values = channel.values;
  const cubic = channel.interpolation === "CUBICSPLINE";
  // Cubic spline keys store in-tangent, value, out-tangent.
  const keyStride = cubic ? width * 3 : width;
  const valueOffset = cubic ? width : 0;
  const last = times.length - 1;
  if (last < 0) return;
  if (time <= times[0] || last === 0) {
    for (let c = 0; c < width; c++) out[c] = values[valueOffset + c];
    return;
  }
  if (time >= times[last]) {
    for (let c = 0; c < width; c++) out[c] = values[last * keyStride + valueOffset + c];
    return;
  }
  let k = 0;
  while (k < last - 1 && times[k + 1] <= time) k++;
  const t0 = times[k];
  const dt = times[k + 1] - t0;
  const u = dt > 0 ? (time - t0) / dt : 0;
  const a = k * keyStride;
  const b = (k + 1) * keyStride;
  if (channel.interpolation === "STEP") {
    for (let c = 0; c < width; c++) out[c] = values[a + c];
    return;
  }
  if (cubic) {
    const u2 = u * u;
    const u3 = u2 * u;
    for (let c = 0; c < width; c++) {
      const p0 = values[a + width + c];
      const m0 = values[a + 2 * width + c] * dt;
      const p1 = values[b + width + c];
      const m1 = values[b + c] * dt;
      out[c] = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
    }
    if (width === 4) normalize4(out);
    return;
  }
  if (width === 4) {
    slerp(values, a, values, b, u, out);
    return;
  }
  for (let c = 0; c < width; c++) out[c] = values[a + c] + (values[b + c] - values[a + c]) * u;
}

function normalize4(q: Float32Array): void {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  for (let c = 0; c < 4; c++) q[c] /= len;
}

// Float32Array only: scriptc rejects ArrayLike parameters.
function slerp(qa: Float32Array, a: number, qb: Float32Array, b: number, u: number, out: Float32Array): void {
  let d = qa[a] * qb[b] + qa[a + 1] * qb[b + 1] + qa[a + 2] * qb[b + 2] + qa[a + 3] * qb[b + 3];
  // Take the short way around.
  const sign = d < 0 ? -1 : 1;
  d *= sign;
  let wa = 1 - u;
  let wb = u * sign;
  if (d < 0.9995) {
    const theta = Math.acos(d);
    const sin = Math.sin(theta);
    wa = Math.sin((1 - u) * theta) / sin;
    wb = (Math.sin(u * theta) / sin) * sign;
  }
  for (let c = 0; c < 4; c++) out[c] = qa[a + c] * wa + qb[b + c] * wb;
  normalize4(out);
}

// Samples clip at time (seconds, wrapped when loop) into pose. weight < 1 blends from what the pose already holds,
// which is how a crossfade runs: sample the old clip at 1, then the new one at the fade's progress.
export function sampleAnimation(pose: Pose, clip: GlbAnimation, time: number, loop: boolean, weight = 1): void {
  const t = loop && clip.duration > 0 ? ((time % clip.duration) + clip.duration) % clip.duration : time;
  const value = new Float32Array(4);
  const current = new Float32Array(4);
  for (const channel of clip.channels) {
    const offset = channel.path === "translation" ? T : channel.path === "rotation" ? R : channel.path === "scale" ? S : -1;
    if (offset < 0) continue;
    const width = offset === R ? 4 : 3;
    sampleChannel(channel, t, width, value);
    const base = channel.node * STRIDE + offset;
    if (weight >= 1) {
      for (let c = 0; c < width; c++) pose.locals[base + c] = value[c];
      continue;
    }
    for (let c = 0; c < width; c++) current[c] = pose.locals[base + c];
    if (width === 4) {
      const blended = new Float32Array(4);
      slerp(current, 0, value, 0, weight, blended);
      for (let c = 0; c < 4; c++) pose.locals[base + c] = blended[c];
    } else {
      for (let c = 0; c < 3; c++) pose.locals[base + c] = current[c] + (value[c] - current[c]) * weight;
    }
  }
}

function localMatrix(locals: Float32Array, node: number, out: Float32Array): void {
  const o = node * STRIDE;
  const [x, y, z, w] = [locals[o + R], locals[o + R + 1], locals[o + R + 2], locals[o + R + 3]];
  const [sx, sy, sz] = [locals[o + S], locals[o + S + 1], locals[o + S + 2]];
  out[0] = (1 - 2 * (y * y + z * z)) * sx;
  out[1] = 2 * (x * y + z * w) * sx;
  out[2] = 2 * (x * z - y * w) * sx;
  out[3] = 0;
  out[4] = 2 * (x * y - z * w) * sy;
  out[5] = (1 - 2 * (x * x + z * z)) * sy;
  out[6] = 2 * (y * z + x * w) * sy;
  out[7] = 0;
  out[8] = 2 * (x * z + y * w) * sz;
  out[9] = 2 * (y * z - x * w) * sz;
  out[10] = (1 - 2 * (x * x + y * y)) * sz;
  out[11] = 0;
  out[12] = locals[o + T];
  out[13] = locals[o + T + 1];
  out[14] = locals[o + T + 2];
  out[15] = 1;
}

function multiplyInto(a: Float32Array, ao: number, b: Float32Array, bo: number, out: Float32Array, oo: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[ao + k * 4 + r] * b[bo + c * 4 + k];
      out[oo + c * 4 + r] = sum;
    }
  }
}

// World matrix of every node for this pose (16 floats each).
export function worldMatrices(model: GlbModel, pose: Pose): Float32Array {
  const count = model.nodes.length;
  const worlds = new Float32Array(count * 16);
  const done = new Uint8Array(count);
  const local = new Float32Array(16);
  const resolve = (i: number): void => {
    if (done[i]) return;
    const parent = model.nodes[i].parent;
    // Resolve the parent first: it reuses the local scratch matrix.
    if (parent >= 0) resolve(parent);
    localMatrix(pose.locals, i, local);
    if (parent < 0) worlds.set(local, i * 16);
    else multiplyInto(worlds, parent * 16, local, 0, worlds, i * 16);
    done[i] = 1;
  };
  for (let i = 0; i < count; i++) resolve(i);
  return worlds;
}

// Joint matrices for skin (world * inverse bind), 16 floats per joint slot, ready for MeshRef.joints.
export function jointMatrices(model: GlbModel, pose: Pose, skin: number, out?: Float32Array): Float32Array {
  const s = model.skins[skin];
  const worlds = worldMatrices(model, pose);
  const result = out ?? new Float32Array(s.joints.length * 16);
  for (let j = 0; j < s.joints.length; j++) multiplyInto(worlds, s.joints[j] * 16, s.inverseBind, j * 16, result, j * 16);
  return result;
}
