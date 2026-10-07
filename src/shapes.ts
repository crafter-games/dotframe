import type { MeshData } from "./gltf";

// Unit cube centered at the origin: side 1, from -0.5 to 0.5 on each axis, so scale is the full size. Per-face normals.
export function box(): MeshData {
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint32Array(36);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let f = 0; f < 6; f++) {
    const face = faces[f];
    for (let c = 0; c < 4; c++) {
      const vertex = f * 4 + c;
      const su = corners[c][0] * 0.5;
      const sv = corners[c][1] * 0.5;
      for (let axis = 0; axis < 3; axis++) {
        positions[vertex * 3 + axis] = face.n[axis] * 0.5 + face.u[axis] * su + face.v[axis] * sv;
        normals[vertex * 3 + axis] = face.n[axis];
      }
    }
    const base = f * 4;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], f * 6);
  }
  return { positions, normals, indices };
}
