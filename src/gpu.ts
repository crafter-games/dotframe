// Backend-agnostic surface shared by game code. Backends return plain objects of functions:
// scriptc compiles structural types as record copies, so classes cannot stand in for interfaces.

export interface WindowOptions {
  width: number;
  height: number;
  title: string;
}

export interface Color {
  r: number;
  g: number;
  b: number;
}

export const BufferUsage = { Vertex: 1, Index: 2, Uniform: 4 };
export const VertexFormat = { Float32x2: 0, Float32x3: 1, Float32x4: 2 };

export interface VertexAttribute {
  format: number;
  offset: number;
  location: number;
}

export interface PipelineOptions {
  wgsl: string;
  // Bytes per vertex; 0 when the shader generates vertices itself.
  stride: number;
  attributes: VertexAttribute[];
  depth: boolean;
}

// Negative handles mean "none". With an index buffer, count is the number of uint32 indices.
export interface Draw {
  pipeline: number;
  bindGroup: number;
  vertexBuffer: number;
  indexBuffer: number;
  count: number;
}

export interface Gpu {
  createBuffer: (usage: number, data: Uint8Array) => number;
  writeBuffer: (buffer: number, data: Uint8Array) => void;
  createPipeline: (options: PipelineOptions) => number;
  bindUniform: (pipeline: number, buffer: number) => number;
  frame: (clear: Color, draws: Draw[]) => void;
  aspect: () => number;
}

// Called every frame with elapsed seconds; return false to stop.
export type Frame = (gpu: Gpu, time: number) => boolean;

// Called once after the GPU is ready.
export type Setup = (gpu: Gpu) => Frame;

export function f32Bytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function u32Bytes(data: Uint32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
