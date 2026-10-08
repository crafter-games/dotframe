// Shrinks a game's assets for shipping: GLBs keep only what loadGlb reads, and opaque PNG textures become JPEG.
// Sources stay untouched; the slim copy goes to the build output.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

// Vertex attributes loadGlb reads. Everything else (TANGENT, TEXCOORD_1, COLOR_0, morph targets) is dead weight.
const KEPT_ATTRIBUTES = ["POSITION", "NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"];
// Required extensions loadGlb understands; any other one makes the rewrite back off.
const KNOWN_REQUIRED = ["KHR_materials_pbrSpecularGlossiness"];
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

// biome-ignore lint/suspicious/noExplicitAny: glTF JSON is rewritten field by field.
type Json = any;

export interface SlimImage {
  index: number;
  bytes: Uint8Array;
  mimeType: string;
  // True when the material ignores alpha (OPAQUE) or the PNG has no alpha channel.
  opaque: boolean;
}

export interface GlbParts {
  doc: Json;
  bin: Uint8Array;
}

export function readGlb(bytes: Uint8Array): GlbParts | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== CHUNK_JSON) return null;
  const jsonLength = view.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const at = 20 + jsonLength;
  const bin = at + 8 <= bytes.byteLength && view.getUint32(at + 4, true) === CHUNK_BIN ? bytes.subarray(at + 8, at + 8 + view.getUint32(at, true)) : new Uint8Array(0);
  return { doc, bin };
}

export function writeGlb(doc: Json, bin: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(bin.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + (binLength ? 8 + binLength : 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  if (binLength) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, CHUNK_BIN, true);
    out.set(bin, 28 + jsonLength);
  }
  return out;
}

function baseColorRef(m: Json): Json {
  return m.pbrMetallicRoughness?.baseColorTexture ?? m.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture;
}

function pngHasAlpha(bytes: Uint8Array): boolean {
  // Unknown formats count as having alpha. PNG: color type 4 (gray + alpha), 6 (RGBA), or a tRNS chunk.
  if (bytes[0] !== 0x89) return true;
  return bytes[25] === 4 || bytes[25] === 6 || hasChunk(bytes, "tRNS");
}

function hasChunk(bytes: Uint8Array, name: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.byteLength; ) {
    const length = view.getUint32(at);
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === name) return true;
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "IDAT") return false;
    at += 12 + length;
  }
  return false;
}

// Rewrites a GLB to the parts loadGlb reads: kept vertex attributes, indices, skins, animations and base color
// images. Unused accessors, buffer views and images go away and indices are renumbered. Returns null when the file
// uses something the rewrite does not understand (extra buffers, sparse accessors, required extensions), so the
// caller copies it unchanged. clips keeps only the animations with those names (exact, or after "Armature|");
// a GLB with none of them keeps all of its own.
export function slimGlb(bytes: Uint8Array, recode?: (image: SlimImage) => { bytes: Uint8Array; mimeType: string } | null, clips?: string[]): Uint8Array | null {
  const parts = readGlb(bytes);
  if (!parts) return null;
  const doc = structuredClone(parts.doc);
  if (clips && clips.length > 0 && doc.animations) {
    const wanted = (a: Json): boolean => clips.some((c: string) => a.name === c || String(a.name ?? "").endsWith(`|${c}`));
    if (doc.animations.some(wanted)) doc.animations = doc.animations.filter(wanted);
  }
  if ((doc.buffers?.length ?? 0) > 1 || (doc.extensionsRequired ?? []).some((e: string) => !KNOWN_REQUIRED.includes(e)) || (doc.accessors ?? []).some((a: Json) => a.sparse)) return null;
  if ((doc.images ?? []).some((i: Json) => i.bufferView === undefined)) return null;

  for (const mesh of doc.meshes ?? []) {
    for (const p of mesh.primitives) {
      for (const key of Object.keys(p.attributes)) if (!KEPT_ATTRIBUTES.includes(key)) delete p.attributes[key];
      delete p.targets;
    }
    delete mesh.weights;
  }

  // Images reached from a base color slot, and whether that material ignores alpha.
  const usedImages = new Map<number, boolean>();
  const materials: Json[] = doc.materials ?? [];
  for (const m of materials) {
    const ref = baseColorRef(m);
    const source = ref ? doc.textures?.[ref.index]?.source : undefined;
    if (source !== undefined) usedImages.set(source, (usedImages.get(source) ?? true) && (m.alphaMode ?? "OPAQUE") === "OPAQUE");
    if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.extensions?.KHR_materials_pbrSpecularGlossiness) delete m.extensions.KHR_materials_pbrSpecularGlossiness.specularGlossinessTexture;
  }
  const imageMap = new Map<number, number>();
  const images: Json[] = [];
  const imageBytes: Uint8Array[] = [];
  for (const [old] of [...usedImages].sort((a, b) => a[0] - b[0])) {
    const image = doc.images[old];
    const view = doc.bufferViews[image.bufferView];
    let data = parts.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    let mimeType = image.mimeType ?? "";
    const opaque = usedImages.get(old) === true || (mimeType === "image/png" && !pngHasAlpha(data));
    const recoded = recode?.({ index: old, bytes: data, mimeType, opaque });
    if (recoded && recoded.bytes.byteLength < data.byteLength) {
      data = recoded.bytes;
      mimeType = recoded.mimeType;
    }
    imageMap.set(old, images.length);
    images.push({ ...image, mimeType, bufferView: -1 });
    imageBytes.push(data);
  }
  const textureMap = new Map<number, number>();
  const textures: Json[] = [];
  (doc.textures ?? []).forEach((t: Json, i: number) => {
    if (t.source === undefined || !imageMap.has(t.source)) return;
    textureMap.set(i, textures.length);
    textures.push({ ...t, source: imageMap.get(t.source) });
  });
  for (const m of materials) {
    const ref = baseColorRef(m);
    if (ref) ref.index = textureMap.get(ref.index);
  }

  // Accessors still referenced, in first-use order.
  const indexAccessors = new Set<number>();
  for (const mesh of doc.meshes ?? []) for (const p of mesh.primitives) if (p.indices !== undefined) indexAccessors.add(p.indices);
  const accessorMap = new Map<number, number>();
  const keep = (i: number | undefined): number | undefined => {
    if (i === undefined) return undefined;
    if (!accessorMap.has(i)) accessorMap.set(i, accessorMap.size);
    return accessorMap.get(i);
  };
  for (const mesh of doc.meshes ?? []) {
    for (const p of mesh.primitives) {
      for (const key of Object.keys(p.attributes)) p.attributes[key] = keep(p.attributes[key]);
      if (p.indices !== undefined) p.indices = keep(p.indices);
    }
  }
  for (const s of doc.skins ?? []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = keep(s.inverseBindMatrices);
  for (const a of doc.animations ?? []) for (const s of a.samplers) {
    s.input = keep(s.input);
    s.output = keep(s.output);
  }

  // New binary chunk: each kept view once, 4-byte aligned, then the images.
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: Json[] = [];
  const viewMap = new Map<number, number>();
  const append = (data: Uint8Array, view: Json): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) chunks.push(new Uint8Array(pad));
    length += pad;
    bufferViews.push({ ...view, buffer: 0, byteOffset: length, byteLength: data.byteLength });
    chunks.push(data);
    length += data.byteLength;
    return bufferViews.length - 1;
  };
  const accessors: Json[] = [];
  for (const [old] of [...accessorMap].sort((a, b) => a[1] - b[1])) {
    const accessor = { ...doc.accessors[old] };
    const wide = indexAccessors.has(old) && accessor.componentType === UNSIGNED_INT ? u32View(parts.bin, doc, accessor) : null;
    if (wide && fitsU16(wide, accessor.count)) {
      const v = doc.bufferViews[accessor.bufferView];
      const narrow = new Uint8Array(accessor.count * 2);
      const out = new DataView(narrow.buffer);
      for (let i = 0; i < accessor.count; i++) out.setUint16(i * 2, wide.getUint32(i * 4, true), true);
      accessor.componentType = UNSIGNED_SHORT;
      accessor.byteOffset = undefined;
      accessor.bufferView = append(narrow, { target: v.target });
      accessors.push(accessor);
      continue;
    }
    const element = (COMPONENTS[accessor.type] ?? 1) * (COMPONENT_BYTES[accessor.componentType] ?? 4);
    const stride = accessor.bufferView === undefined ? undefined : doc.bufferViews[accessor.bufferView].byteStride;
    if (accessor.bufferView !== undefined && (stride === undefined || stride === element)) {
      // Tightly packed: copy just this accessor's bytes. Exporters (Blender, Godot) pack every animation accessor
      // into a few large views, so keeping whole views would keep the clips that were dropped. A stride equal to
      // the element size is packed too (Godot writes 12 and 16 on its VEC3 and VEC4 animation views).
      const v = doc.bufferViews[accessor.bufferView];
      const start = (v.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const size = accessor.count * element;
      accessor.bufferView = append(parts.bin.subarray(start, start + size), { target: v.target });
      accessor.byteOffset = undefined;
      accessors.push(accessor);
      continue;
    }
    if (accessor.bufferView !== undefined) {
      if (!viewMap.has(accessor.bufferView)) {
        const v = doc.bufferViews[accessor.bufferView];
        viewMap.set(accessor.bufferView, append(parts.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), { byteStride: v.byteStride, target: v.target }));
      }
      accessor.bufferView = viewMap.get(accessor.bufferView);
    }
    accessors.push(accessor);
  }
  images.forEach((image, i) => {
    image.bufferView = append(imageBytes[i], {});
  });
  const bin = new Uint8Array(Math.ceil(length / 4) * 4);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }

  doc.accessors = accessors.map((a) => Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)));
  doc.bufferViews = bufferViews.map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)));
  doc.buffers = [{ byteLength: bin.byteLength }];
  if (images.length) doc.images = images;
  else delete doc.images;
  if (textures.length) doc.textures = textures;
  else delete doc.textures;
  if (!doc.textures) delete doc.samplers;
  return writeGlb(doc, bin);
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function u32View(bin: Uint8Array, doc: Json, accessor: Json): DataView | null {
  if (accessor.bufferView === undefined) return null;
  const v = doc.bufferViews[accessor.bufferView];
  if (v.byteStride !== undefined && v.byteStride !== 4) return null;
  return new DataView(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0) + (accessor.byteOffset ?? 0), accessor.count * 4);
}

function fitsU16(view: DataView, count: number): boolean {
  for (let i = 0; i < count; i++) if (view.getUint32(i * 4, true) > 0xffff) return false;
  return true;
}

// Opaque PNG to JPEG through ffmpeg (quality 2..31, lower is better). Null when ffmpeg is missing or fails.
export function pngToJpeg(bytes: Uint8Array, quality: number): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "dotframe-slim-"));
  try {
    writeFileSync(join(dir, "in.png"), bytes);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "in.png"), "-q:v", String(quality), join(dir, "out.jpg")]);
    if (r.status !== 0) return null;
    return new Uint8Array(readFileSync(join(dir, "out.jpg")));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SlimEntry {
  path: string;
  before: number;
  after: number;
  note?: string;
}

export interface SlimReport {
  before: number;
  after: number;
  files: SlimEntry[];
  jpeg: boolean;
}

export function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"]).status === 0;
}

// Copies src to out, slimming every .glb on the way. Other files are copied as they are.
export function slimAssets(src: string, out: string, options: { jpeg?: boolean; quality?: number; clips?: string[] } = {}): SlimReport {
  const jpeg = options.jpeg !== false && ffmpegAvailable();
  const quality = options.quality ?? 3;
  const report: SlimReport = { before: 0, after: 0, files: [], jpeg };
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name);
      if (statSync(from).isDirectory()) {
        walk(from);
        continue;
      }
      const rel = relative(src, from);
      const to = join(out, rel);
      mkdirSync(dirname(to), { recursive: true });
      const before = statSync(from).size;
      let after = before;
      let note: string | undefined;
      if (name.toLowerCase().endsWith(".glb")) {
        const slim = slimGlb(new Uint8Array(readFileSync(from)), jpeg ? (image) => (image.opaque && image.mimeType === "image/png" ? (b => b && { bytes: b, mimeType: "image/jpeg" })(pngToJpeg(image.bytes, quality)) : null) : undefined, options.clips);
        if (slim && slim.byteLength < before) {
          writeFileSync(to, slim);
          after = slim.byteLength;
        } else {
          copyFileSync(from, to);
          note = slim ? "already slim" : "copied unchanged (unsupported layout)";
        }
        report.files.push({ path: rel, before, after, ...(note ? { note } : {}) });
      } else copyFileSync(from, to);
      report.before += before;
      report.after += after;
    }
  };
  walk(src);
  return report;
}
