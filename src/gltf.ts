// Reads the first mesh primitive of a binary glTF (.glb): positions, normals and indices.

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

interface GltfAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
}

interface GltfBufferView {
  byteOffset?: number;
  byteLength: number;
}

interface GltfDocument {
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  meshes: { primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number }[] }[];
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;

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
