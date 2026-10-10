// Quadric edge collapse (Garland and Heckbert) for assets slim --decimate. Each collapse moves a vertex onto one of
// its neighbors, so the kept vertex keeps its own normal, UV, joints and weights: static and rigid-skinned meshes
// both come out whole. The topology is welded by position first: exporters split vertices on every UV and normal
// seam (a flat-shaded model has none shared at all), and those copies are one point. Each face corner keeps its
// own copy, and a collapse hands it the copy of the target the collapsing face used on that side. A vertex on an
// open edge (the rim of a plate, a cut) only slides along that rim, held by a stiff plane across it, so outlines
// keep their shape. A collapse that would flip a face is skipped.

// Index list in, shorter index list out, for a triangle list over positions (x, y, z per vertex). With normals, a
// corner with no copy paired by the collapse takes the copy of the target whose normal faces most like the face.
export function decimate(positions: Float32Array, indices: Uint32Array, ratio: number, normals?: Float32Array): Uint32Array {
  const faces = indices.length / 3;
  const target = Math.max(1, Math.floor(faces * ratio));
  const n = positions.length / 3;
  if (ratio >= 1 || faces <= 1) return indices;
  const canon = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const k = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    const c = seen.get(k);
    if (c === undefined) seen.set(k, v);
    canon[v] = c ?? v;
  }
  const copies = new Map<number, number[]>();
  for (let v = 0; v < n; v++) {
    const list = copies.get(canon[v]);
    if (list) list.push(v);
    else copies.set(canon[v], [v]);
  }
  const corner = Uint32Array.from(indices);
  const tri = indices.map((v: number): number => canon[v]);
  const alive = new Uint8Array(faces).fill(1);
  const q = new Float64Array(n * 10);
  const vertFaces: number[][] = Array.from({ length: n }, (): number[] => []);
  for (let f = 0; f < faces; f++) {
    const a = tri[f * 3];
    const b = tri[f * 3 + 1];
    const c = tri[f * 3 + 2];
    vertFaces[a].push(f);
    vertFaces[b].push(f);
    vertFaces[c].push(f);
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const d = -(nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2]);
    // Weighted by area, so a sliver does not count as much as a wall.
    const w = len * 0.5;
    const plane = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) for (let i = 0; i < 10; i++) q[v * 10 + i] += plane[i] * w;
  }
  // Open edges: used by one face only.
  const locked = new Uint8Array(n);
  const edgeUse = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * n + b : b * n + a);
  for (let f = 0; f < faces; f++) {
    for (let e = 0; e < 3; e++) {
      const k = key(tri[f * 3 + e], tri[f * 3 + ((e + 1) % 3)]);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  }
  const rim = new Set<number>();
  for (const [k, uses] of edgeUse) {
    if (uses !== 1) continue;
    rim.add(k);
    locked[Math.floor(k / n)] = 1;
    locked[k % n] = 1;
  }
  // The plane through each rim edge, square to its face, weighted heavily.
  for (let f = 0; f < faces; f++) {
    for (let e = 0; e < 3; e++) {
      const a = tri[f * 3 + e];
      const b = tri[f * 3 + ((e + 1) % 3)];
      if (!rim.has(key(a, b))) continue;
      const c = tri[f * 3 + ((e + 2) % 3)];
      const ex = positions[b * 3] - positions[a * 3];
      const ey = positions[b * 3 + 1] - positions[a * 3 + 1];
      const ez = positions[b * 3 + 2] - positions[a * 3 + 2];
      const fx = positions[c * 3] - positions[a * 3];
      const fy = positions[c * 3 + 1] - positions[a * 3 + 1];
      const fz = positions[c * 3 + 2] - positions[a * 3 + 2];
      const nx = ey * fz - ez * fy;
      const ny = ez * fx - ex * fz;
      const nz = ex * fy - ey * fx;
      let px = ny * ez - nz * ey;
      let py = nz * ex - nx * ez;
      let pz = nx * ey - ny * ex;
      const len = Math.hypot(px, py, pz);
      if (len === 0) continue;
      px /= len;
      py /= len;
      pz /= len;
      const d = -(px * positions[a * 3] + py * positions[a * 3 + 1] + pz * positions[a * 3 + 2]);
      const w = Math.hypot(ex, ey, ez) * Math.hypot(ex, ey, ez) * 100;
      const plane = [px * px, px * py, px * pz, px * d, py * py, py * pz, py * d, pz * pz, pz * d, d * d];
      for (const v of [a, b]) for (let i = 0; i < 10; i++) q[v * 10 + i] += plane[i] * w;
    }
  }
  const error = (from: number, to: number): number => {
    const x = positions[to * 3];
    const y = positions[to * 3 + 1];
    const z = positions[to * 3 + 2];
    const s = (i: number): number => q[from * 10 + i] + q[to * 10 + i];
    return s(0) * x * x + 2 * s(1) * x * y + 2 * s(2) * x * z + 2 * s(3) * x + s(4) * y * y + 2 * s(5) * y * z + 2 * s(6) * y + s(7) * z * z + 2 * s(8) * z + s(9);
  };
  // A binary heap of candidate collapses (cost, from, to, from's stamp). A stale entry is skipped when popped.
  const stamp = new Uint32Array(n);
  const removed = new Uint8Array(n);
  const hc: number[] = [];
  const hf: number[] = [];
  const ht: number[] = [];
  const hs: number[] = [];
  const swap = (i: number, j: number): void => {
    [hc[i], hc[j]] = [hc[j], hc[i]];
    [hf[i], hf[j]] = [hf[j], hf[i]];
    [ht[i], ht[j]] = [ht[j], ht[i]];
    [hs[i], hs[j]] = [hs[j], hs[i]];
  };
  const push = (from: number, to: number): void => {
    if (from === to || (locked[from] && !rim.has(key(from, to)))) return;
    let i = hc.length;
    hc.push(error(from, to));
    hf.push(from);
    ht.push(to);
    hs.push(stamp[from] + stamp[to] * 0x10000);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hc[p] <= hc[i]) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): void => {
    const last = hc.length - 1;
    swap(0, last);
    hc.pop();
    hf.pop();
    ht.pop();
    hs.pop();
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < hc.length && hc[l] < hc[m]) m = l;
      if (r < hc.length && hc[r] < hc[m]) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };
  for (const k of edgeUse.keys()) {
    const a = Math.floor(k / n);
    const b = k % n;
    push(a, b);
    push(b, a);
  }
  const normal = (f: number, from: number, to: number): number[] => {
    const p = [0, 1, 2].map((e: number): number => (tri[f * 3 + e] === from ? to : tri[f * 3 + e]));
    const ux = positions[p[1] * 3] - positions[p[0] * 3];
    const uy = positions[p[1] * 3 + 1] - positions[p[0] * 3 + 1];
    const uz = positions[p[1] * 3 + 2] - positions[p[0] * 3 + 2];
    const vx = positions[p[2] * 3] - positions[p[0] * 3];
    const vy = positions[p[2] * 3 + 1] - positions[p[0] * 3 + 1];
    const vz = positions[p[2] * 3 + 2] - positions[p[0] * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  let live = faces;
  while (live > target && hc.length > 0) {
    const from = hf[0];
    const to = ht[0];
    const s = hs[0];
    pop();
    if (removed[from] || removed[to] || s !== stamp[from] + stamp[to] * 0x10000) continue;
    const around = vertFaces[from].filter((f: number): boolean => alive[f] === 1);
    const shared = (f: number): boolean => tri[f * 3] === to || tri[f * 3 + 1] === to || tri[f * 3 + 2] === to;
    if (!around.some(shared)) continue;
    let flips = false;
    for (const f of around) {
      if (shared(f)) continue;
      const before = normal(f, from, from);
      const after = normal(f, from, to);
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) {
        flips = true;
        break;
      }
    }
    if (flips) continue;
    // The collapsing faces pair each copy of from with the copy of to they used.
    const pair = new Map<number, number>();
    let anyTo = -1;
    for (const f of around) {
      if (!shared(f)) continue;
      let a = -1;
      let b = -1;
      for (let e = 0; e < 3; e++) {
        if (tri[f * 3 + e] === from) a = corner[f * 3 + e];
        if (tri[f * 3 + e] === to) b = corner[f * 3 + e];
      }
      pair.set(a, b);
      anyTo = b;
    }
    for (const f of around) {
      if (shared(f)) {
        alive[f] = 0;
        live--;
        continue;
      }
      for (let e = 0; e < 3; e++) {
        if (tri[f * 3 + e] !== from) continue;
        tri[f * 3 + e] = to;
        const paired = pair.get(corner[f * 3 + e]);
        if (paired !== undefined || !normals) corner[f * 3 + e] = paired ?? anyTo;
        else {
          const g = normal(f, -1, -1);
          let best = anyTo;
          let bestDot = -Infinity;
          for (const v of copies.get(to) ?? []) {
            const d = normals[v * 3] * g[0] + normals[v * 3 + 1] * g[1] + normals[v * 3 + 2] * g[2];
            if (d > bestDot) {
              bestDot = d;
              best = v;
            }
          }
          corner[f * 3 + e] = best;
        }
      }
      vertFaces[to].push(f);
    }
    removed[from] = 1;
    for (let i = 0; i < 10; i++) q[to * 10 + i] += q[from * 10 + i];
    stamp[to]++;
    vertFaces[to] = vertFaces[to].filter((f: number): boolean => alive[f] === 1);
    const next = new Set<number>();
    for (const f of vertFaces[to]) for (let e = 0; e < 3; e++) if (tri[f * 3 + e] !== to) next.add(tri[f * 3 + e]);
    for (const v of next) {
      stamp[v]++;
      push(to, v);
      push(v, to);
    }
    // The neighbors' other edges carry the old stamp now; queue them again with the new one.
    for (const v of next) {
      for (const f of vertFaces[v]) {
        if (!alive[f]) continue;
        for (let e = 0; e < 3; e++) {
          const w = tri[f * 3 + e];
          if (w !== v && w !== to) push(v, w);
        }
      }
    }
  }
  const out: number[] = [];
  for (let f = 0; f < faces; f++) if (alive[f]) out.push(corner[f * 3], corner[f * 3 + 1], corner[f * 3 + 2]);
  return Uint32Array.from(out);
}

// biome-ignore lint/suspicious/noExplicitAny: glTF JSON is rewritten field by field.
type Json = any;
const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

// Decimates every indexed triangle primitive of a parsed GLB to ratio of its faces, and drops the vertices no face
// uses any more. The new accessors go after the old bytes; slimGlb then keeps only what is still referenced.
export function decimateGlb(doc: Json, bin: Uint8Array, ratio: number): Uint8Array {
  const extra: Uint8Array[] = [];
  let length = bin.byteLength;
  const append = (data: Uint8Array, target?: number): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) extra.push(new Uint8Array(pad));
    length += pad;
    doc.bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: data.byteLength,
      ...(target ? { target } : {}),
    });
    extra.push(data);
    length += data.byteLength;
    return doc.bufferViews.length - 1;
  };
  const element = (a: Json): number => (COMPONENTS[a.type] ?? 1) * (COMPONENT_BYTES[a.componentType] ?? 4);
  const bytesOf = (a: Json, i: number): Uint8Array => {
    const v = doc.bufferViews[a.bufferView];
    const size = element(a);
    const at = (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (v.byteStride ?? size);
    return bin.subarray(at, at + size);
  };
  for (const mesh of doc.meshes ?? []) {
    for (const p of mesh.primitives) {
      if ((p.mode ?? 4) !== 4 || p.indices === undefined || p.targets) continue;
      const pos = doc.accessors[p.attributes.POSITION];
      if (!pos || pos.componentType !== 5126 || pos.type !== "VEC3" || pos.bufferView === undefined) continue;
      const ia = doc.accessors[p.indices];
      if (ia.bufferView === undefined) continue;
      const positions = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const b = bytesOf(pos, i);
        const d = new DataView(b.buffer, b.byteOffset, 12);
        positions[i * 3] = d.getFloat32(0, true);
        positions[i * 3 + 1] = d.getFloat32(4, true);
        positions[i * 3 + 2] = d.getFloat32(8, true);
      }
      const indices = new Uint32Array(ia.count);
      for (let i = 0; i < ia.count; i++) {
        const b = bytesOf(ia, i);
        indices[i] = b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) : b.length === 2 ? b[0] | (b[1] << 8) : b[0];
      }
      const nor = doc.accessors[p.attributes.NORMAL];
      let normals: Float32Array | undefined;
      if (nor && nor.componentType === 5126 && nor.type === "VEC3" && nor.bufferView !== undefined) {
        normals = new Float32Array(nor.count * 3);
        for (let i = 0; i < nor.count; i++) {
          const b = bytesOf(nor, i);
          const d = new DataView(b.buffer, b.byteOffset, 12);
          for (let c = 0; c < 3; c++) normals[i * 3 + c] = d.getFloat32(c * 4, true);
        }
      }
      const kept = decimate(positions, indices, ratio, normals);
      if (kept.length >= indices.length) continue;
      const remap = new Int32Array(pos.count).fill(-1);
      const order: number[] = [];
      for (const i of kept) if (remap[i] < 0) remap[i] = order.push(i) - 1;
      for (const name of Object.keys(p.attributes)) {
        const a = doc.accessors[p.attributes[name]];
        if (a.bufferView === undefined || a.sparse) continue;
        const size = element(a);
        const data = new Uint8Array(order.length * size);
        order.forEach((old: number, i: number): void => data.set(bytesOf(a, old), i * size));
        const next: Json = {
          ...a,
          bufferView: append(data, 34962),
          count: order.length,
        };
        delete next.byteOffset;
        if (name === "POSITION") {
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (const old of order)
            for (let c = 0; c < 3; c++) {
              min[c] = Math.min(min[c], positions[old * 3 + c]);
              max[c] = Math.max(max[c], positions[old * 3 + c]);
            }
          next.min = min;
          next.max = max;
        }
        doc.accessors.push(next);
        p.attributes[name] = doc.accessors.length - 1;
      }
      const out = new Uint32Array(kept.length);
      for (let i = 0; i < kept.length; i++) out[i] = remap[kept[i]];
      doc.accessors.push({
        bufferView: append(new Uint8Array(out.buffer), 34963),
        componentType: 5125,
        count: out.length,
        type: "SCALAR",
      });
      p.indices = doc.accessors.length - 1;
    }
  }
  const merged = new Uint8Array(Math.ceil(length / 4) * 4);
  merged.set(bin);
  let at = bin.byteLength;
  for (const c of extra) {
    merged.set(c, at);
    at += c.byteLength;
  }
  doc.buffers[0].byteLength = merged.byteLength;
  return merged;
}
