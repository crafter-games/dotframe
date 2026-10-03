import type { World } from "./ecs";
import type { MeshData } from "./gltf";
import { BufferUsage, type Color, type Draw, f32Bytes, type Gpu, u32Bytes, VertexFormat } from "./gpu";
import { compose, lookAt, multiply, perspective, type Vec3, vec3 } from "./math";

export interface Camera {
  eye: Vec3;
  target: Vec3;
  fovY: number;
}

export interface Renderer {
  addMesh: (data: MeshData) => number;
  render: (world: World, camera: Camera, clear: Color) => void;
}

interface GpuMesh {
  vertexBuffer: number;
  indexBuffer: number;
  count: number;
}

interface EntityBinding {
  uniformBuffer: number;
  bindGroup: number;
}

const shader = `
struct Uniforms {
  mvp: mat4x4f,
  model: mat4x4f,
  color: vec4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
}

@vertex
fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = u.mvp * vec4f(position, 1.0);
  out.normal = (u.model * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let light = normalize(vec3f(0.4, 0.8, 0.6));
  let diffuse = max(dot(normalize(in.normal), light), 0.0);
  return vec4f(u.color.rgb * (0.25 + 0.75 * diffuse), 1.0);
}
`;

// mvp (16) + model (16) + color (4) floats.
const UNIFORM_FLOATS = 36;

export function createRenderer(gpu: Gpu): Renderer {
  const pipeline = gpu.createPipeline({
    wgsl: shader,
    stride: 24,
    attributes: [
      { format: VertexFormat.Float32x3, offset: 0, location: 0 },
      { format: VertexFormat.Float32x3, offset: 12, location: 1 },
    ],
    depth: true,
  });
  const meshes: GpuMesh[] = [];
  const bindings = new Map<number, EntityBinding>();
  const uniforms = new Float32Array(UNIFORM_FLOATS);

  const addMesh = (data: MeshData): number => {
    const vertexCount = data.positions.length / 3;
    const interleaved = new Float32Array(vertexCount * 6);
    for (let i = 0; i < vertexCount; i++) {
      interleaved[i * 6] = data.positions[i * 3];
      interleaved[i * 6 + 1] = data.positions[i * 3 + 1];
      interleaved[i * 6 + 2] = data.positions[i * 3 + 2];
      interleaved[i * 6 + 3] = data.normals[i * 3];
      interleaved[i * 6 + 4] = data.normals[i * 3 + 1];
      interleaved[i * 6 + 5] = data.normals[i * 3 + 2];
    }
    meshes.push({
      vertexBuffer: gpu.createBuffer(BufferUsage.Vertex, f32Bytes(interleaved)),
      indexBuffer: gpu.createBuffer(BufferUsage.Index, u32Bytes(data.indices)),
      count: data.indices.length,
    });
    return meshes.length - 1;
  };

  const render = (world: World, camera: Camera, clear: Color): void => {
    const view = lookAt(camera.eye, camera.target, vec3(0, 1, 0));
    const viewProjection = multiply(perspective(camera.fovY, gpu.aspect(), 0.1, 100), view);
    const draws: Draw[] = [];
    for (const [entity, meshRef] of world.meshes) {
      const transform = world.transforms.get(entity);
      const mesh = meshes[meshRef.mesh];
      if (!transform || !mesh) continue;

      let binding = bindings.get(entity);
      if (!binding) {
        const uniformBuffer = gpu.createBuffer(BufferUsage.Uniform, f32Bytes(uniforms));
        binding = { uniformBuffer, bindGroup: gpu.bindUniform(pipeline, uniformBuffer) };
        bindings.set(entity, binding);
      }

      const model = compose(transform.position, transform.rotation, transform.scale);
      uniforms.set(multiply(viewProjection, model), 0);
      uniforms.set(model, 16);
      uniforms[32] = meshRef.color.x;
      uniforms[33] = meshRef.color.y;
      uniforms[34] = meshRef.color.z;
      uniforms[35] = 1;
      gpu.writeBuffer(binding.uniformBuffer, f32Bytes(uniforms));

      draws.push({
        pipeline,
        bindGroup: binding.bindGroup,
        vertexBuffer: mesh.vertexBuffer,
        indexBuffer: mesh.indexBuffer,
        count: mesh.count,
      });
    }
    gpu.frame(clear, draws);
  };

  return { addMesh, render };
}
