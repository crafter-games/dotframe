import { readFileSync } from "node:fs";
import type { Color, Draw, Gpu, PipelineOptions, Setup, Texture, WindowOptions } from "../gpu";
import type { Input } from "../input";
import {
  dfBegin,
  dfBind,
  dfBuffer,
  dfBufferWrite,
  dfClose,
  dfDraw,
  dfEnd,
  dfGamepadAxis,
  dfGamepadButton,
  dfHeight,
  dfImage,
  dfKeyDown,
  dfOpen,
  dfPipeline,
  dfPoll,
  dfTexture,
  dfTextureHeight,
  dfTextureWidth,
  dfWidth,
} from "./ffi";

const PIPELINE_DEPTH = 1;
const PIPELINE_BLEND = 4;

// SDL scancodes indexed by the engine Key ids in src/input.ts.
const scancodes = [80, 79, 82, 81, 44, 26, 4, 22, 7, 13, 14, 15, 41, 40];

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
      const flags = (pipelineOptions.depth ? PIPELINE_DEPTH : 0) | (pipelineOptions.blend ? PIPELINE_BLEND : 0);
      const attributeBytes = new Uint8Array(attributes.buffer, attributes.byteOffset, attributes.byteLength);
      const pipeline = dfPipeline(pipelineOptions.wgsl, pipelineOptions.stride, attributeBytes, flags);
      if (pipeline < 0) throw new Error(`dfPipeline failed: ${pipeline}`);
      if (pipelineOptions.depth) depthPipelines.add(pipeline);
      return pipeline;
    },
    bind: (pipeline: number, buffer: number, texture: number): number => {
      const group = dfBind(pipeline, buffer, texture);
      if (group < 0) throw new Error(`dfBind failed: ${group}`);
      return group;
    },
    createTexture: (width: number, height: number, rgba: Uint8Array): Texture => {
      const id = dfTexture(width, height, rgba);
      if (id < 0) throw new Error(`dfTexture failed: ${id}`);
      return { id, width, height };
    },
    createImage: async (png: Uint8Array): Promise<Texture> => {
      const id = dfImage(png);
      if (id < 0) throw new Error(`dfImage failed: ${id}`);
      return { id, width: dfTextureWidth(id), height: dfTextureHeight(id) };
    },
    frame: (clear: Color, draws: Draw[]): void => {
      // Pipelines without depth cannot run in a pass with a depth attachment.
      let usesDepth = false;
      for (const draw of draws) if (depthPipelines.has(draw.pipeline)) usesDepth = true;
      if (dfBegin(clear.r, clear.g, clear.b, usesDepth) !== 0) return;
      for (const draw of draws) {
        dfDraw(draw.pipeline, draw.bindGroup, draw.vertexBuffer, draw.indexBuffer, draw.first, draw.count);
      }
      dfEnd();
    },
    aspect: (): number => dfWidth() / Math.max(dfHeight(), 1),
  };

  const input: Input = {
    down: (key: number): boolean => key >= 0 && key < scancodes.length && dfKeyDown(scancodes[key]),
    axis: (axis: number): number => dfGamepadAxis(axis),
    button: (button: number): boolean => dfGamepadButton(button),
  };

  const frame = setup(gpu, input);
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
