// Full-screen post-processing: render the scene into a target (gpu.frame(clear, draws, target)), then draw this
// pass, which samples the target with your fragment code. Queue its draw with Draw2D.scene so a HUD lands on top.
import { BufferUsage, type Draw, f32Bytes, type RenderGpu, type Texture } from "./gpu";

export const POST_PARAMS = 16;

export interface PostPass {
  // The texture to render the scene into, sized on the last resize (undefined until then).
  target: () => Texture | undefined;
  // Makes the target width x height pixels. Call when the surface shape changes; it keeps the same target otherwise.
  resize: (width: number, height: number) => void;
  // The pass's draw for this frame. params fill u.params[0..3] (16 floats); the shader sees them as vec4s.
  draw: (params: Float32Array) => Draw;
}

// fragment is WGSL that defines `fn post(uv: vec2f, pixel: vec2f) -> vec4f`. It can read `src` (texture_2d<f32>),
// `samp` (linear, clamp to edge) and `u.params` (array<vec4f, 4>); pixel is the fragment's position in pixels.
export function createPostPass(gpu: RenderGpu, fragment: string): PostPass {
  const wgsl = `
struct Uniforms { params: array<vec4f, 4> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// One triangle covering the screen; no vertex buffer.
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VertexOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: VertexOut;
  out.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}

${fragment}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return post(in.uv, in.position.xy);
}
`;
  const pipeline = gpu.createPipeline({ wgsl, stride: 0, attributes: [], depth: false, blend: false });
  const uniformBuffer = gpu.createBuffer(BufferUsage.Uniform, new Uint8Array(POST_PARAMS * 4));
  let texture: Texture | undefined;
  let bindGroup = -1;
  return {
    target: (): Texture | undefined => texture,
    resize: (width: number, height: number): void => {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (texture && texture.width === w && texture.height === h) return;
      if (texture) gpu.destroyTexture(texture);
      texture = gpu.createTarget(w, h);
      bindGroup = gpu.bind(pipeline, uniformBuffer, texture.id);
    },
    draw: (params: Float32Array): Draw => {
      gpu.writeBuffer(uniformBuffer, f32Bytes(params));
      return { pipeline, bindGroup, vertexBuffer: -1, indexBuffer: -1, first: 0, count: 3 };
    },
  };
}
