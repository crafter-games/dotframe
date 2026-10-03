import type { Color, Gpu, Setup, WindowOptions } from "../gpu";
import { dfClose, dfFrame, dfOpen, dfPipeline, dfPoll } from "./ffi";

export async function run(options: WindowOptions, setup: Setup): Promise<void> {
  const status = dfOpen(options.width, options.height, options.title);
  if (status !== 0) throw new Error(`dfOpen failed: ${status}`);

  const gpu: Gpu = {
    createPipeline: (wgsl: string): number => {
      const pipeline = dfPipeline(wgsl);
      if (pipeline < 0) throw new Error(`dfPipeline failed: ${pipeline}`);
      return pipeline;
    },
    frame: (clear: Color, pipeline: number, vertexCount: number): void => {
      dfFrame(clear.r, clear.g, clear.b, pipeline, vertexCount);
    },
  };

  const frame = setup(gpu);
  // DF_FRAMES bounds the run for headless checks.
  const maxFrames = Number(process.env.DF_FRAMES ?? "0");
  let index = 0;
  while (dfPoll()) {
    if (!frame(gpu, index)) break;
    index++;
    if (maxFrames > 0 && index >= maxFrames) break;
  }
  dfClose();
}
