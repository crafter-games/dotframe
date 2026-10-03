declare function dfOpen(width: number, height: number, title: string): number;
declare function dfPipeline(wgsl: string): number;
declare function dfPoll(): boolean;
declare function dfFrame(r: number, g: number, b: number, pipeline: number, vertexCount: number): number;
declare function dfClose(): void;

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

const status = dfOpen(800, 600, "dotframe: triangle");
if (status !== 0) {
  console.error(`dfOpen failed: ${status}`);
  process.exit(1);
}

const pipeline = dfPipeline(shader);
if (pipeline < 0) {
  console.error(`dfPipeline failed: ${pipeline}`);
  process.exit(1);
}

const maxFrames = Number(process.env.DF_FRAMES ?? "0");
let frame = 0;
while (dfPoll()) {
  dfFrame(0.06, 0.06, 0.1, pipeline, 3);
  frame++;
  if (maxFrames > 0 && frame >= maxFrames) break;
}

dfClose();
console.log(`frames: ${frame}`);
