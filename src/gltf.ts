// Binary glTF (.glb). parseGlb reads the first primitive's geometry; loadGlb reads a whole static model: every
// primitive of every node, baked into model space, with texture coordinates, materials and embedded images.

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  // Two floats per vertex. Present when the mesh is UV-mapped; the renderer samples textures with them.
  uvs?: Float32Array;
}

export interface GlbMaterial {
  // Base color factor (linear RGBA), multiplied with the texture.
  color: [number, number, number, number];
  // Index into GlbModel.images, or -1.
  image: number;
  // "OPAQUE", "MASK" (cut out below alphaCutoff) or "BLEND" (drawn as MASK at 0.5 for now).
  alphaMode: string;
  alphaCutoff: number;
  emissive: [number, number, number];
  name: string;
}

export interface GlbImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GlbPrimitive {
  mesh: MeshData;
  // Index into GlbModel.materials, or -1 for the default white material.
  material: number;
  // The node that holds it, for debugging and picking parts.
  node: string;
}

export interface GlbModel {
  primitives: GlbPrimitive[];
  materials: GlbMaterial[];
  images: GlbImage[];
  // Axis-aligned bounds of the baked model, to place and scale it.
  min: number[];
  max: number[];
}

interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
}

interface GltfBufferView {
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfAttributes {
  POSITION: number;
  NORMAL?: number;
  TEXCOORD_0?: number;
  JOINTS_0?: number;
  WEIGHTS_0?: number;
}

interface GltfPrimitive {
  attributes: GltfAttributes;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfTextureRef {
  index: number;
}

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureRef };
  extensions?: { KHR_materials_pbrSpecularGlossiness?: { diffuseFactor?: number[]; diffuseTexture?: GltfTextureRef } };
  alphaMode?: string;
  alphaCutoff?: number;
  emissiveFactor?: number[];
}

interface GltfFullDocument {
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  meshes: { primitives: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes: number[] }[];
  scene?: number;
  materials?: GltfMaterial[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
}

interface GltfDocument {
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  meshes: { primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number }[] }[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT_BYTE = 5120;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_SHORT = 5122;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const COMPONENT_FLOAT = 5126;
const MODE_TRIANGLES = 4;

export function parseGlb(bytes: Uint8Array): MeshData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB file");

  let offset = 12;
  let json = "";
  let binOffset = -1;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === CHUNK_JSON) json = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === CHUNK_BIN) binOffset = bytes.byteOffset + offset + 8;
    offset += 8 + length;
  }
  if (json === "" || binOffset < 0) throw new Error("GLB is missing its JSON or BIN chunk");

  const doc = JSON.parse(json) as GltfDocument;
  const primitive = doc.meshes[0].primitives[0];

  const accessorStart = (index: number): number => {
    const accessor = doc.accessors[index];
    const bufferView = doc.bufferViews[accessor.bufferView];
    return binOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  };

  const readVec3 = (index: number): Float32Array => {
    const count = doc.accessors[index].count;
    const start = accessorStart(index);
    const out = new Float32Array(count * 3);
    const source = new DataView(bytes.buffer, start, count * 12);
    for (let i = 0; i < count * 3; i++) out[i] = source.getFloat32(i * 4, true);
    return out;
  };

  const indexAccessor = doc.accessors[primitive.indices];
  const indexStart = accessorStart(primitive.indices);
  const indices = new Uint32Array(indexAccessor.count);
  const indexView = new DataView(bytes.buffer, indexStart);
  for (let i = 0; i < indexAccessor.count; i++) {
    if (indexAccessor.componentType === COMPONENT_UNSIGNED_SHORT) indices[i] = indexView.getUint16(i * 2, true);
    else if (indexAccessor.componentType === COMPONENT_UNSIGNED_INT) indices[i] = indexView.getUint32(i * 4, true);
    else throw new Error(`unsupported index component type ${indexAccessor.componentType}`);
  }

  return {
    positions: readVec3(primitive.attributes.POSITION),
    normals: readVec3(primitive.attributes.NORMAL),
    indices,
  };
}

function readChunks(bytes: Uint8Array): { json: string; bin: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB file");
  let offset = 12;
  let json = "";
  let bin = -1;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === CHUNK_JSON) json = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === CHUNK_BIN) bin = offset + 8;
    offset += 8 + length;
  }
  if (json === "" || bin < 0) throw new Error("GLB is missing its JSON or BIN chunk");
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function componentSize(type: number): number {
  if (type === COMPONENT_BYTE || type === COMPONENT_UNSIGNED_BYTE) return 1;
  if (type === COMPONENT_SHORT || type === COMPONENT_UNSIGNED_SHORT) return 2;
  return 4;
}

// Reads any accessor as floats, honoring byteStride and normalized integer components.
function readAccessor(bytes: Uint8Array, bin: number, doc: GltfFullDocument, index: number): Float32Array {
  const accessor = doc.accessors[index];
  const width = COMPONENTS[accessor.type] ?? 1;
  const size = componentSize(accessor.componentType);
  const out = new Float32Array(accessor.count * width);
  if (accessor.bufferView === undefined) return out;
  const bufferView = doc.bufferViews[accessor.bufferView];
  const stride = bufferView.byteStride ?? width * size;
  const start = bytes.byteOffset + bin + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bytes.buffer, start, Math.max(0, (accessor.count - 1) * stride + width * size));
  const norm = accessor.normalized === true;
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < width; c++) {
      const at = i * stride + c * size;
      let v = 0;
      const t = accessor.componentType;
      if (t === COMPONENT_FLOAT) v = view.getFloat32(at, true);
      else if (t === COMPONENT_UNSIGNED_INT) v = view.getUint32(at, true);
      else if (t === COMPONENT_UNSIGNED_SHORT) v = norm ? view.getUint16(at, true) / 65535 : view.getUint16(at, true);
      else if (t === COMPONENT_SHORT) v = norm ? Math.max(view.getInt16(at, true) / 32767, -1) : view.getInt16(at, true);
      else if (t === COMPONENT_UNSIGNED_BYTE) v = norm ? view.getUint8(at) / 255 : view.getUint8(at);
      else v = norm ? Math.max(view.getInt8(at) / 127, -1) : view.getInt8(at);
      out[i * width + c] = v;
    }
  }
  return out;
}

// Column-major local matrix of a node from its matrix or translation, rotation (quaternion) and scale.
function nodeMatrix(node: GltfNode): Float32Array {
  if (node.matrix && node.matrix.length === 16) return new Float32Array(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const m = new Float32Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

function identityMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function material(doc: GltfFullDocument, m: GltfMaterial): GlbMaterial {
  const pbr = m.pbrMetallicRoughness;
  const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness;
  const factor = pbr?.baseColorFactor ?? sg?.diffuseFactor ?? [1, 1, 1, 1];
  const textureRef = pbr?.baseColorTexture ?? sg?.diffuseTexture;
  const source = textureRef ? (doc.textures?.[textureRef.index]?.source ?? -1) : -1;
  const e = m.emissiveFactor ?? [0, 0, 0];
  return {
    color: [factor[0], factor[1], factor[2], factor[3] ?? 1],
    image: source,
    alphaMode: m.alphaMode ?? "OPAQUE",
    alphaCutoff: m.alphaCutoff ?? 0.5,
    emissive: [e[0], e[1], e[2]],
    name: m.name ?? "",
  };
}

export function loadGlb(bytes: Uint8Array): GlbModel {
  const { json, bin } = readChunks(bytes);
  const doc = JSON.parse(json) as GltfFullDocument;
  const nodes = doc.nodes ?? [];
  const primitives: GlbPrimitive[] = [];
  // Arrays, not tuples: scriptc indexes tuples only with literals.
  const min: number[] = [Infinity, Infinity, Infinity];
  const max: number[] = [-Infinity, -Infinity, -Infinity];

  // World matrix of every node at rest, for skinned meshes, whose joints place them instead of their own node.
  const worlds: Float32Array[] = nodes.map((): Float32Array => new Float32Array(0));
  const place = (nodeIndex: number, parent: Float32Array): void => {
    worlds[nodeIndex] = multiplyMatrices(parent, nodeMatrix(nodes[nodeIndex]));
    for (const child of nodes[nodeIndex].children ?? []) place(child, worlds[nodeIndex]);
  };

  const bake = (nodeIndex: number, parent: Float32Array): void => {
    const node = nodes[nodeIndex];
    const world = multiplyMatrices(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const p of doc.meshes[node.mesh].primitives) {
        if ((p.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
        let local = readAccessor(bytes, bin, doc, p.attributes.POSITION);
        const count = local.length / 3;
        let localNormals = p.attributes.NORMAL !== undefined ? readAccessor(bytes, bin, doc, p.attributes.NORMAL) : new Float32Array(count * 3);
        const skin = node.skin !== undefined ? doc.skins?.[node.skin] : undefined;
        let transform = world;
        if (skin && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) {
          const skinned = restPose(skin, readAccessor(bytes, bin, doc, p.attributes.JOINTS_0), readAccessor(bytes, bin, doc, p.attributes.WEIGHTS_0), local, localNormals);
          local = skinned.positions;
          localNormals = skinned.normals;
          transform = identityMatrix();
        }
        const positions = new Float32Array(count * 3);
        const normals = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const [x, y, z] = [local[i * 3], local[i * 3 + 1], local[i * 3 + 2]];
          for (let r = 0; r < 3; r++) {
            const v = transform[r] * x + transform[4 + r] * y + transform[8 + r] * z + transform[12 + r];
            positions[i * 3 + r] = v;
            if (v < min[r]) min[r] = v;
            if (v > max[r]) max[r] = v;
          }
          // Upper 3x3, renormalized: exact for rotations and uniform scale, which is what exporters write.
          const [nx, ny, nz] = [localNormals[i * 3], localNormals[i * 3 + 1], localNormals[i * 3 + 2]];
          const tx = transform[0] * nx + transform[4] * ny + transform[8] * nz;
          const ty = transform[1] * nx + transform[5] * ny + transform[9] * nz;
          const tz = transform[2] * nx + transform[6] * ny + transform[10] * nz;
          const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          normals[i * 3] = tx / len;
          normals[i * 3 + 1] = ty / len;
          normals[i * 3 + 2] = tz / len;
        }
        let indices: Uint32Array;
        if (p.indices !== undefined) {
          const raw = readAccessor(bytes, bin, doc, p.indices);
          indices = new Uint32Array(raw.length);
          for (let i = 0; i < raw.length; i++) indices[i] = raw[i];
        } else {
          indices = new Uint32Array(count);
          for (let i = 0; i < count; i++) indices[i] = i;
        }
        // A mirroring transform flips the winding, which back-face culling would hide.
        const det =
          transform[0] * (transform[5] * transform[10] - transform[9] * transform[6]) -
          transform[4] * (transform[1] * transform[10] - transform[9] * transform[2]) +
          transform[8] * (transform[1] * transform[6] - transform[5] * transform[2]);
        if (det < 0) {
          for (let i = 0; i + 2 < indices.length; i += 3) {
            const t = indices[i + 1];
            indices[i + 1] = indices[i + 2];
            indices[i + 2] = t;
          }
        }
        const mesh: MeshData = { positions, normals, indices };
        if (p.attributes.TEXCOORD_0 !== undefined) mesh.uvs = readAccessor(bytes, bin, doc, p.attributes.TEXCOORD_0);
        primitives.push({ mesh, material: p.material ?? -1, node: node.name ?? "" });
      }
    }
    for (const child of node.children ?? []) bake(child, world);
  };

  const roots = doc.scenes?.[doc.scene ?? 0]?.nodes ?? nodes.map((_: GltfNode, i: number): number => i);
  for (const root of roots) place(root, identityMatrix());

  // Linear blend skinning at rest: each vertex is the weighted sum of its joints' world * inverse bind.
  function restPose(skin: { joints: number[]; inverseBindMatrices?: number }, joints: Float32Array, weights: Float32Array, positions: Float32Array, normalsIn: Float32Array): { positions: Float32Array; normals: Float32Array } {
    const inverse = skin.inverseBindMatrices !== undefined ? readAccessor(bytes, bin, doc, skin.inverseBindMatrices) : new Float32Array(0);
    const jointMatrices = skin.joints.map((joint: number, j: number): Float32Array => {
      const ibm = inverse.length > 0 ? inverse.subarray(j * 16, j * 16 + 16) : identityMatrix();
      return multiplyMatrices(worlds[joint].length ? worlds[joint] : identityMatrix(), ibm);
    });
    const count = positions.length / 3;
    const outP = new Float32Array(count * 3);
    const outN = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const [nx, ny, nz] = [normalsIn[i * 3], normalsIn[i * 3 + 1], normalsIn[i * 3 + 2]];
      for (let k = 0; k < 4; k++) {
        const w = weights[i * 4 + k];
        if (w === 0) continue;
        const m = jointMatrices[joints[i * 4 + k]];
        if (!m) continue;
        for (let r = 0; r < 3; r++) {
          outP[i * 3 + r] += w * (m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
          outN[i * 3 + r] += w * (m[r] * nx + m[4 + r] * ny + m[8 + r] * nz);
        }
      }
    }
    return { positions: outP, normals: outN };
  }

  for (const root of roots) bake(root, identityMatrix());

  const images: GlbImage[] = [];
  for (const image of doc.images ?? []) {
    if (image.bufferView === undefined) {
      images.push({ bytes: new Uint8Array(0), mimeType: "" });
      continue;
    }
    const view = doc.bufferViews[image.bufferView];
    const start = bin + (view.byteOffset ?? 0);
    images.push({ bytes: bytes.subarray(start, start + view.byteLength), mimeType: image.mimeType ?? "" });
  }
  return { primitives, materials: (doc.materials ?? []).map((m: GltfMaterial): GlbMaterial => material(doc, m)), images, min, max };
}
