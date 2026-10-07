import { expect, test } from "bun:test";
import { readGlb, slimGlb, writeGlb } from "../cli/slim";
import { loadGlb } from "../src/gltf";

// A PNG signature and IHDR whose color type (byte 25) says RGBA. Not decodable, enough for the alpha check.
function rgbaPng(): ArrayBuffer {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes[25] = 6;
  return bytes.buffer;
}

// One triangle with a tangent, a second UV set, a normal map and a base color image.
function fixture(alphaMode = "OPAQUE"): Uint8Array {
  const parts: ArrayBuffer[] = [
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer,
    new Float32Array([0, 0, 1, 0, 0, 1]).buffer,
    new Float32Array(12).buffer,
    new Float32Array(6).buffer,
    new Uint32Array([0, 1, 2]).buffer,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer,
    rgbaPng(),
  ];
  const bin: number[] = [];
  const views = parts.map((p) => {
    while (bin.length % 4) bin.push(0);
    const view = { buffer: 0, byteOffset: bin.length, byteLength: p.byteLength };
    bin.push(...new Uint8Array(p));
    return view;
  });
  while (bin.length % 4) bin.push(0);
  const acc = (bufferView: number, type: string, count: number, componentType = 5126) => ({ bufferView, type, count, componentType });
  const doc = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [acc(0, "VEC3", 3), acc(1, "VEC3", 3), acc(2, "VEC2", 3), acc(3, "VEC4", 3), acc(4, "VEC2", 3), acc(5, "SCALAR", 3, 5125)],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3, TEXCOORD_1: 4 }, indices: 5, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, alphaMode }],
    textures: [{ source: 1 }, { source: 0 }],
    images: [{ bufferView: 6, mimeType: "image/png" }, { bufferView: 7, mimeType: "image/png" }],
  };
  return writeGlb(doc, new Uint8Array(bin));
}

test("slimGlb drops unread attributes and images and keeps what loadGlb returns", () => {
  const before = fixture();
  const after = slimGlb(before);
  expect(after).not.toBeNull();
  const doc = readGlb(after as Uint8Array)?.doc;
  expect(Object.keys(doc.meshes[0].primitives[0].attributes).sort()).toEqual(["NORMAL", "POSITION", "TEXCOORD_0"]);
  expect(doc.images.length).toBe(1);
  expect(doc.materials[0].normalTexture).toBeUndefined();
  expect(doc.accessors[doc.meshes[0].primitives[0].indices].componentType).toBe(5123);
  const a = loadGlb(before);
  const b = loadGlb(after as Uint8Array);
  expect(b.primitives).toEqual(a.primitives);
  expect([...b.images[b.materials[0].image].bytes]).toEqual([...a.images[a.materials[0].image].bytes]);
});

test("slimGlb recodes only images whose material ignores alpha", () => {
  const recode = () => ({ bytes: new Uint8Array([0xff, 0xd8]), mimeType: "image/jpeg" });
  const opaque = readGlb(slimGlb(fixture("OPAQUE"), (i) => (i.opaque ? recode() : null)) as Uint8Array)?.doc;
  const blended = readGlb(slimGlb(fixture("BLEND"), (i) => (i.opaque ? recode() : null)) as Uint8Array)?.doc;
  expect(opaque.images[0].mimeType).toBe("image/jpeg");
  // An RGBA PNG under a BLEND material keeps its alpha.
  expect(blended.images[0].mimeType).toBe("image/png");
});

test("slimGlb backs off on extensions it does not know", () => {
  const parts = readGlb(fixture());
  const doc = { ...parts?.doc, extensionsRequired: ["KHR_draco_mesh_compression"] };
  expect(slimGlb(writeGlb(doc, parts?.bin as Uint8Array))).toBeNull();
});
