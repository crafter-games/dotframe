import { readFileSync } from "node:fs";
import type { Color, Draw, Gpu, PipelineOptions, Setup, WindowOptions } from "../gpu";
import {
  dfBegin,
  dfBindUniform,
  dfBuffer,
  dfBufferWrite,
  dfClose,
  dfDraw,
  dfEnd,
  dfHeight,
  dfOpen,
  dfPipeline,
  dfPoll,
  dfWidth,
} from "./ffi";

const PIPELINE_DEPTH = 1;

export async function loadBytes(path: string): Promise<Uint8Array> {
  const data = readFileSync(path);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function run(options: WindowOptions, setup: Setup): Promise<void> {
  const status = dfOpen(options.width, options.height, options.title);
  if (status !== 0) throw new Error(`dfOpen failed: ${status}`);

  const depthPipelines = new Set<number>();
  const gpu: Gpu = {
    createBuffer: (usage: number, data: Uint8Array): number => {
      const buffer = dfBuffer(usage, data);
      if (buffer < 0) throw new Error(`dfBuffer failed: ${buffer}`);
      return buffer;
    },
    writeBuffer: (buffer: number, data: Uint8Array): void => dfBufferWrite(buffer, data),
    createPipeline: (pipelineOptions: PipelineOptions): number => {
      const attributes = new Uint32Array(pipelineOptions.attributes.length * 3);
      for (let i = 0; i < pipelineOptions.attributes.length; i++) {
        const attribute = pipelineOptions.attributes[i];
        attributes[i * 3] = attribute.format;
        attributes[i * 3 + 1] = attribute.offset;
        attributes[i * 3 + 2] = attribute.location;
      }
      const flags = pipelineOptions.depth ? PIPELINE_DEPTH : 0;
      const attributeBytes = new Uint8Array(attributes.buffer, attributes.byteOffset, attributes.byteLength);
      const pipeline = dfPipeline(pipelineOptions.wgsl, pipelineOptions.stride, attributeBytes, flags);
      if (pipeline < 0) throw new Error(`dfPipeline failed: ${pipeline}`);
      if (pipelineOptions.depth) depthPipelines.add(pipeline);
      return pipeline;
    },
    bindUniform: (pipeline: number, buffer: number): number => {
      const group = dfBindUniform(pipeline, buffer);
      if (group < 0) throw new Error(`dfBindUniform failed: ${group}`);
      return group;
    },
    frame: (clear: Color, draws: Draw[]): void => {
      // Pipelines without depth cannot run in a pass with a depth attachment.
      let usesDepth = false;
      for (const draw of draws) if (depthPipelines.has(draw.pipeline)) usesDepth = true;
      if (dfBegin(clear.r, clear.g, clear.b, usesDepth) !== 0) return;
      for (const draw of draws) dfDraw(draw.pipeline, draw.bindGroup, draw.vertexBuffer, draw.indexBuffer, draw.count);
      dfEnd();
    },
    aspect: (): number => dfWidth() / Math.max(dfHeight(), 1),
  };

  const frame = setup(gpu);
  // DF_FRAMES bounds the run for headless checks.
  const maxFrames = Number(process.env.DF_FRAMES ?? "0");
  const start = performance.now();
  let index = 0;
  while (dfPoll()) {
    if (!frame(gpu, (performance.now() - start) / 1000)) break;
    index++;
    if (maxFrames > 0 && index >= maxFrames) break;
  }
  dfClose();
}
