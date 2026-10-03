import type { Frame, Gpu, Setup } from "../../src/gpu";
import type { Input } from "../../src/input";

const shader = `
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let pos = array(vec2f(0.0, 0.6), vec2f(-0.6, -0.5), vec2f(0.6, -0.5));
  return vec4f(pos[i], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.98, 0.45, 0.09, 1.0);
}
`;

export const windowOptions = { width: 800, height: 600, title: "dotframe: triangle" };

export const setup: Setup = (gpu: Gpu, _input: Input): Frame => {
  const pipeline = gpu.createPipeline({ wgsl: shader, stride: 0, attributes: [], depth: false, blend: false });
  return (frameGpu: Gpu, _time: number): boolean => {
    frameGpu.frame({ r: 0.06, g: 0.06, b: 0.1 }, [
      { pipeline, bindGroup: -1, vertexBuffer: -1, indexBuffer: -1, first: 0, count: 3 },
    ]);
    return true;
  };
};
