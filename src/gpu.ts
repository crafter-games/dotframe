import type { Platform } from "./platform";

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
// Unorm8x4: four bytes read as a vec4f in [0, 1], for packed colors.
export const VertexFormat = { Float32x2: 0, Float32x3: 1, Float32x4: 2, Float32: 3, Unorm8x4: 4 };

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
  // Standard alpha blending, for 2D and transparent sprites.
  blend: boolean;
  // A second vertex buffer stepped once per instance (Draw.instanceBuffer), for drawing one mesh many times.
  instanceStride?: number;
  instanceAttributes?: VertexAttribute[];
}

export interface Texture {
  id: number;
  width: number;
  height: number;
}

// Negative handles mean "none". first/count are uint32 indices with an index buffer, vertices otherwise.
export interface Draw {
  pipeline: number;
  bindGroup: number;
  vertexBuffer: number;
  indexBuffer: number;
  first: number;
  count: number;
  // With a pipeline that has instance attributes: the per-instance buffer and how many instances to draw.
  instanceBuffer?: number;
  instances?: number;
}

// Synchronous rendering surface. Code that must also run in scriptc library mode (iOS), where promises are
// unavailable, depends on this instead of Gpu.
export interface RenderGpu {
  createBuffer: (usage: number, data: Uint8Array) => number;
  writeBuffer: (buffer: number, data: Uint8Array) => void;
  destroyBuffer: (buffer: number) => void;
  createPipeline: (options: PipelineOptions) => number;
  // Group 0: binding 0 uniform buffer, binding 1 texture, binding 2 nearest sampler; -1 skips one.
  bind: (pipeline: number, buffer: number, texture: number) => number;
  // smooth: linear filtering (fonts, photos); otherwise nearest (pixel art). mipmaps (implies smooth): a full mip
  // chain and a repeating sampler, for textures tiled across 3D surfaces, so they do not shimmer at distance.
  createTexture: (width: number, height: number, rgba: Uint8Array, smooth: boolean, mipmaps?: boolean) => Texture;
  // Frees a texture (and, natively, the bind groups sampling it). Its id is never reused; do not draw it again.
  // Required, not optional: scriptc cannot call an optional function.
  destroyTexture: (texture: Texture) => void;
  // Draws a frame. With target (from createTarget), it renders into that texture with its own depth and presents
  // nothing, so a later frame can sample it (post-processing).
  frame: (clear: Color, draws: Draw[], target?: Texture) => void;
  // A texture pipelines can render into and shaders can sample, in the surface's format. Free it with destroyTexture.
  createTarget: (width: number, height: number) => Texture;
  aspect: () => number;
}

export interface Gpu extends RenderGpu {
  // Decodes PNG or JPEG bytes. mipmaps as in createTexture.
  createImage: (png: Uint8Array, smooth: boolean, mipmaps?: boolean) => Promise<Texture>;
}

// Called every frame with elapsed seconds; return false to stop.
export type Frame = (time: number) => boolean;

// Called once after the backend is ready.
export type Setup = (platform: Platform) => Frame;

export function f32Bytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function u32Bytes(data: Uint32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
