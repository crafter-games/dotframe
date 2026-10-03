import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Audio } from "../audio";
import type { Color, Draw, Gpu, PipelineOptions, Setup, Texture, WindowOptions } from "../gpu";
import { type Input, keyScancodes, type Pointer } from "../input";
import type { Storage } from "../storage";
import {
  dfAudioOpen,
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
  dfMasterVolume,
  dfMusicPause,
  dfMusicPlay,
  dfMusicStop,
  dfMusicVolume,
  dfKeyDown,
  dfMouseButtons,
  dfMouseX,
  dfMouseY,
  dfOpen,
  dfPipeline,
  dfPlay,
  dfPoll,
  dfPrefPath,
  dfSound,
  dfTexture,
  dfTextureHeight,
  dfTextureWidth,
  dfTone,
  dfTrack,
  dfWidth,
} from "./ffi";

const PIPELINE_DEPTH = 1;
const PIPELINE_BLEND = 4;


export async function loadBytes(path: string): Promise<Uint8Array> {
  const data = readFileSync(path);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// Stores values as one JSON object in <prefs>/dotframe/<app>/storage.json, rewritten on every set.
function openStorage(app: string): Storage {
  const pathBytes = new Uint8Array(1024);
  const length = dfPrefPath("dotframe", app.split(":").join("").split("/").join("-"), pathBytes);
  const file = length > 0 ? `${new TextDecoder().decode(pathBytes.subarray(0, length))}storage.json` : "";
  const values = new Map<string, string>();
  if (file !== "" && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const key of Object.keys(saved)) values.set(key, saved[key]);
  }
  return {
    get: (key: string): string | null => values.get(key) ?? null,
    set: (key: string, value: string): void => {
      values.set(key, value);
      if (file === "") return;
      const out: Record<string, string> = {};
      for (const [k, v] of values) out[k] = v;
      writeFileSync(file, JSON.stringify(out));
    },
  };
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
    createTexture: (width: number, height: number, rgba: Uint8Array, smooth: boolean): Texture => {
      const id = dfTexture(width, height, rgba, smooth);
      if (id < 0) throw new Error(`dfTexture failed: ${id}`);
      return { id, width, height };
    },
    createImage: async (png: Uint8Array, smooth: boolean): Promise<Texture> => {
      const id = dfImage(png, smooth);
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
    down: (key: number): boolean => key >= 0 && key < keyScancodes.length && dfKeyDown(keyScancodes[key]),
    firstDown: (): number => {
      for (let key = 0; key < keyScancodes.length; key++) if (dfKeyDown(keyScancodes[key])) return key;
      return -1;
    },
    axis: (pad: number, axis: number): number => dfGamepadAxis(pad, axis),
    button: (pad: number, button: number): boolean => dfGamepadButton(pad, button),
    pointer: (): Pointer => ({ x: dfMouseX(), y: dfMouseY(), buttons: dfMouseButtons() }),
  };

  const storage = openStorage(options.title);

  // A missing audio device leaves sounds silent instead of failing the game.
  const audioReady = dfAudioOpen() === 0;
  if (!audioReady) console.error("dotframe: no audio device, continuing without sound");
  const audio: Audio = {
    loadSound: async (mp3: Uint8Array): Promise<number> => (audioReady ? dfSound(mp3) : -1),
    play: (sound: number, volume: number, rate: number): void => dfPlay(sound, volume, rate),
    tone: (frequency: number, duration: number, volume: number): void => dfTone(frequency, duration, volume),
    loadMusic: async (mp3: Uint8Array): Promise<number> => dfTrack(mp3),
    playMusic: (track: number, loop: boolean, volume: number): void => {
      dfMusicPlay(track, loop, volume);
    },
    stopMusic: (): void => dfMusicStop(),
    pauseMusic: (paused: boolean): void => dfMusicPause(paused),
    setMusicVolume: (volume: number): void => dfMusicVolume(volume),
    setMasterVolume: (volume: number): void => dfMasterVolume(volume),
  };

  const frame = setup({ gpu, input, audio, storage });
  // DF_FRAMES bounds the run for headless checks.
  const maxFrames = Number(process.env.DF_FRAMES ?? "0");
  const start = performance.now();
  let index = 0;
  while (dfPoll()) {
    if (!frame((performance.now() - start) / 1000)) break;
    // Let promise callbacks queued by game code (asset loads, timers) run, as the browser does between frames.
    await Promise.resolve();
    index++;
    if (maxFrames > 0 && index >= maxFrames) break;
  }
  dfClose();
}
