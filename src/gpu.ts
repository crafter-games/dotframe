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

export interface Gpu {
  createPipeline: (wgsl: string) => number;
  frame: (clear: Color, pipeline: number, vertexCount: number) => void;
}

// Called every frame; return false to stop.
export type Frame = (gpu: Gpu, index: number) => boolean;

// Called once after the GPU is ready.
export type Setup = (gpu: Gpu) => Frame;
