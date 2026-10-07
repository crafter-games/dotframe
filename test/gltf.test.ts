import { expect, test } from "bun:test";
import { loadGlb, parseGlb } from "../src/gltf";

// Builds a GLB from a JSON document and binary chunks, so each test states exactly what it feeds the loader.
function glb(json: object, buffers: ArrayBuffer[]): Uint8Array {
  const bin: number[] = [];
  const views: { byteOffset: number; byteLength: number }[] = [];
  for (const b of buffers) {
    while (bin.length % 4) bin.push(0);
    views.push({ byteOffset: bin.length, byteLength: b.byteLength });
    bin.push(...new Uint8Array(b));
  }
  while (bin.length % 4) bin.push(0);
  const doc = new TextEncoder().encode(JSON.stringify({ ...json, bufferViews: views, buffers: [{ byteLength: bin.length }] }));
  const jsonLength = Math.ceil(doc.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + bin.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(doc, 20);
  view.setUint32(20 + jsonLength, bin.length, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

const triangle = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer,
  uvs: new Float32Array([0, 0, 1, 0, 0, 1]).buffer,
  indices: new Uint16Array([0, 1, 2, 0]).buffer,
};
const accessors = [
  { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
  { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
  { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
  { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
];
const buffers = [triangle.positions, triangle.normals, triangle.uvs, triangle.indices, new Uint8Array([1, 2, 3, 4]).buffer];
const primitive = { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 };

test("bakes nested node transforms, reads u16 indices, UVs, materials and embedded images", () => {
  const model = loadGlb(
    glb(
      {
        accessors,
        meshes: [{ primitives: [primitive] }],
        // Parent moves +10 on x and scales by 2; the child turns 90 degrees about y and holds the mesh.
        nodes: [
          { name: "root", translation: [10, 0, 0], scale: [2, 2, 2], children: [1] },
          { name: "part", mesh: 0, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
        ],
        scenes: [{ nodes: [0] }],
        materials: [{ name: "paper", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 1], baseColorTexture: { index: 0 } }, alphaMode: "MASK", alphaCutoff: 0.3 }],
        textures: [{ source: 0 }],
        images: [{ bufferView: 4, mimeType: "image/png" }],
      },
      buffers,
    ),
  );
  expect(model.primitives.length).toBe(1);
  const p = model.primitives[0];
  expect(p.node).toBe("part");
  // (1, 0, 0) turned 90 degrees about y is (0, 0, -1), scaled by 2, moved by 10.
  expect(Array.from(p.mesh.positions.slice(3, 6)).map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([10, 0, -2]);
  // The normal (0, 0, 1) turns to (1, 0, 0) and stays unit length despite the scale.
  expect(Array.from(p.mesh.normals.slice(0, 3)).map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([1, 0, 0]);
  expect(Array.from(p.mesh.indices)).toEqual([0, 1, 2]);
  expect(Array.from(p.mesh.uvs ?? [])).toEqual([0, 0, 1, 0, 0, 1]);
  expect(model.materials[0]).toMatchObject({ color: [0.5, 0.25, 1, 1], image: 0, alphaMode: "MASK", alphaCutoff: 0.3, name: "paper" });
  expect(model.images[0].mimeType).toBe("image/png");
  expect(Array.from(model.images[0].bytes)).toEqual([1, 2, 3, 4]);
  expect(model.min.map((v) => Math.round(v))).toEqual([10, 0, -2]);
  expect(model.max.map((v) => Math.round(v))).toEqual([10, 2, 0]);
});

test("reads the spec-gloss diffuse as base color and flips winding under a mirroring transform", () => {
  const model = loadGlb(
    glb(
      {
        accessors,
        meshes: [{ primitives: [primitive] }],
        nodes: [{ mesh: 0, scale: [-1, 1, 1] }],
        materials: [{ extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseFactor: [0.2, 0.4, 0.6, 1], diffuseTexture: { index: 0 } } } }],
        textures: [{ source: 0 }],
        images: [{ bufferView: 4, mimeType: "image/png" }],
      },
      buffers,
    ),
  );
  expect(model.materials[0].color).toEqual([0.2, 0.4, 0.6, 1]);
  expect(model.materials[0].image).toBe(0);
  expect(Array.from(model.primitives[0].mesh.indices)).toEqual([0, 2, 1]);
});

test("a skinned mesh is placed by its joints at rest, not by its own node", () => {
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).buffer;
  // The joint sits at y = 5 with an identity inverse bind, so every vertex rises by 5.
  const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer;
  const model = loadGlb(
    glb(
      {
        accessors: [
          ...accessors,
          { bufferView: 5, componentType: 5121, count: 3, type: "VEC4" },
          { bufferView: 6, componentType: 5126, count: 3, type: "VEC4" },
          { bufferView: 7, componentType: 5126, count: 1, type: "MAT4" },
        ],
        meshes: [{ primitives: [{ ...primitive, attributes: { ...primitive.attributes, JOINTS_0: 4, WEIGHTS_0: 5 } }] }],
        // The mesh node's own transform (x 100) must be ignored for a skinned mesh.
        nodes: [{ mesh: 0, skin: 0, translation: [100, 0, 0] }, { name: "hip", translation: [0, 5, 0] }],
        skins: [{ joints: [1], inverseBindMatrices: 6 }],
        materials: [{}],
      },
      [...buffers, joints, weights, ibm],
    ),
  );
  expect(Array.from(model.primitives[0].mesh.positions.slice(3, 6))).toEqual([1, 5, 0]);
});

test("parseGlb still reads the first primitive's geometry", () => {
  const mesh = parseGlb(glb({ accessors, meshes: [{ primitives: [primitive] }] }, buffers));
  expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
  expect(mesh.positions.length).toBe(9);
});

test("a double-sided material adds the back faces: reversed winding, flipped normals", () => {
  const model = loadGlb(glb({ accessors, meshes: [{ primitives: [primitive] }], nodes: [{ mesh: 0 }], materials: [{ doubleSided: true }] }, buffers));
  const m = model.primitives[0].mesh;
  expect(model.materials[0].doubleSided).toBe(true);
  expect(Array.from(m.indices)).toEqual([0, 1, 2, 3, 5, 4]);
  expect(Array.from(m.positions.slice(9, 12))).toEqual([0, 0, 0]);
  expect(Array.from(m.normals.slice(9, 12)).map((v) => v + 0)).toEqual([0, 0, -1]);
  expect(Array.from(m.uvs ?? []).length).toBe(12);
});
