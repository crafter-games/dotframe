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

test("slimGlb keeps only the named clips, and every clip when none match", () => {
  const parts = readGlb(fixture());
  if (!parts) throw new Error("fixture");
  const clip = (name: string, input: number) => ({ name, channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input, output: 0 }] });
  const doc = { ...parts.doc, animations: [clip("Armature|dog_walk", 1), clip("Armature|dog_bark", 3), clip("dog_run", 4)] };
  const glb = writeGlb(doc, parts.bin);
  const names = (bytes: Uint8Array | null): string[] => (readGlb(bytes as Uint8Array)?.doc.animations ?? []).map((a: { name: string }) => a.name);
  const kept = slimGlb(glb, undefined, ["dog_walk", "dog_run"]);
  expect(names(kept)).toEqual(["Armature|dog_walk", "dog_run"]);
  expect((readGlb(kept as Uint8Array)?.doc.accessors ?? []).length).toBeLessThan((readGlb(slimGlb(glb) as Uint8Array)?.doc.accessors ?? []).length);
  expect(names(slimGlb(glb, undefined, ["cat_meow"]))).toEqual(["Armature|dog_walk", "Armature|dog_bark", "dog_run"]);
});

test("slimGlb renames kept clips to the names a game plays", () => {
  const parts = readGlb(fixture());
  if (!parts) throw new Error("fixture");
  const clip = (name: string, input: number) => ({ name, channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input, output: 0 }] });
  const glb = writeGlb({ ...parts.doc, animations: [clip("Armature|labrador_walk_fwd_01", 1), clip("labrador_bark", 3)] }, parts.bin);
  const out = readGlb(slimGlb(glb, undefined, ["labrador_walk_fwd_01"], { labrador_walk_fwd_01: "walk" }) as Uint8Array);
  expect((out?.doc.animations ?? []).map((a: { name: string }) => a.name)).toEqual(["walk"]);
});

test("slimAssets packs a .gltf with an external .bin and image into one GLB", async () => {
	const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { slimAssets } = await import("../cli/slim");
	const dir = mkdtempSync(join(tmpdir(), "gltf-"));
	const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
	writeFileSync(join(dir, "m.bin"), new Uint8Array(positions.buffer));
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
	writeFileSync(join(dir, "diff.jpg"), jpeg);
	writeFileSync(join(dir, "nor.jpg"), new Uint8Array(64));
	const doc = {
		asset: { version: "2.0" },
		buffers: [{ uri: "m.bin", byteLength: 36 }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
		accessors: [
			{
				bufferView: 0,
				type: "VEC3",
				count: 3,
				componentType: 5126,
				min: [0, 0, 0],
				max: [1, 1, 0],
			},
		],
		images: [{ uri: "diff.jpg" }, { uri: "nor.jpg" }],
		textures: [{ source: 0 }, { source: 1 }],
		materials: [
			{
				pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
				normalTexture: { index: 1 },
			},
		],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
		nodes: [{ mesh: 0 }],
		scenes: [{ nodes: [0] }],
	};
	writeFileSync(join(dir, "m.gltf"), JSON.stringify(doc));
	slimAssets(join(dir, "m.gltf"), join(dir, "out.glb"), { jpeg: false });
	const parts = readGlb(new Uint8Array(readFileSync(join(dir, "out.glb"))));
	expect(parts).not.toBeNull();
	expect(parts?.doc.images).toHaveLength(1);
	expect(parts?.doc.buffers[0].uri).toBeUndefined();
	const view = parts?.doc.bufferViews[parts.doc.images[0].bufferView];
	expect([
		...(parts?.bin.subarray(
			view.byteOffset,
			view.byteOffset + view.byteLength,
		) ?? []),
	]).toEqual([...jpeg]);
	const model = loadGlb(new Uint8Array(readFileSync(join(dir, "out.glb"))));
	expect(model.primitives).toHaveLength(1);
});
