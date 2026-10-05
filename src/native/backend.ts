// Native platform pieces shared by the executable loop (run.ts) and the library-mode runtime (library.ts).
// Everything here is synchronous so it also compiles in scriptc library mode, where promises are unavailable.
import type { AudioPlayer } from "../audio";
import type { Color, Draw, PipelineOptions, RenderGpu, Texture } from "../gpu";
import { type Input, keyScancodes, type Pointer, sdlGamepadButtons, type Touch } from "../input";
import {
  dfAudioOpen,
  dfBegin,
  dfBind,
  dfBuffer,
  dfBufferDestroy,
  dfBufferWrite,
  dfDraw,
  dfEnd,
  dfGamepadAxis,
  dfGamepadButton,
  dfHeight,
  dfImage,
  dfKeyDown,
  dfMouse,
  dfPipeline,
  dfMusic,
  dfPlay,
  dfSound,
  dfTexture,
  dfTextureDestroy,
  dfTextureSize,
  dfTone,
  dfTouch,
  dfTouchCount,
  dfTrack,
  dfWidth,
} from "./ffi";

const PIPELINE_DEPTH = 1;
const PIPELINE_BLEND = 4;

export function createNativeRenderGpu(): RenderGpu {
  const depthPipelines = new Set<number>();
  return {
    createBuffer: (usage: number, data: Uint8Array): number => {
      const buffer = dfBuffer(usage, data);
      if (buffer < 0) throw new Error(`dfBuffer failed: ${buffer}`);
      return buffer;
    },
    writeBuffer: (buffer: number, data: Uint8Array): void => dfBufferWrite(buffer, data),
    destroyBuffer: (buffer: number): void => dfBufferDestroy(buffer),
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
    destroyTexture: (texture: Texture): void => dfTextureDestroy(texture.id),
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
}

// Decodes PNG bytes into a texture immediately.
export function createNativeImage(png: Uint8Array, smooth: boolean): Texture {
  const id = dfImage(png, smooth);
  if (id < 0) throw new Error(`dfImage failed: ${id}`);
  return { id, width: dfTextureSize(id, 0), height: dfTextureSize(id, 1) };
}

export function createNativeInput(): Input {
  return {
    down: (key: number): boolean => key >= 0 && key < keyScancodes.length && dfKeyDown(keyScancodes[key]),
    firstDown: (): number => {
      for (let key = 0; key < keyScancodes.length; key++) if (dfKeyDown(keyScancodes[key])) return key;
      return -1;
    },
    axis: (pad: number, axis: number): number => dfGamepadAxis(pad, axis),
    button: (pad: number, button: number): boolean => {
      if (button === 6 || button === 7) return dfGamepadAxis(pad, button === 6 ? 4 : 5) > 0.5;
      const sdl = button >= 0 && button < sdlGamepadButtons.length ? sdlGamepadButtons[button] : -1;
      return sdl >= 0 && dfGamepadButton(pad, sdl);
    },
    pointer: (): Pointer => ({ x: dfMouse(0), y: dfMouse(1), buttons: dfMouse(2) }),
    touches: (): Touch[] => {
      const out: Touch[] = [];
      const count = dfTouchCount();
      for (let i = 0; i < count; i++) out.push({ id: dfTouch(i, 0), x: dfTouch(i, 1), y: dfTouch(i, 2) });
      return out;
    },
  };
}

// Opens the audio device; returns false without one, so games continue silently.
export function openNativeAudio(): boolean {
  const ready = dfAudioOpen() === 0;
  if (!ready) console.error("dotframe: no audio device, continuing without sound");
  return ready;
}

export function createNativeAudioPlayer(): AudioPlayer {
  return {
    play: (sound: number, volume: number, rate: number): void => dfPlay(sound, volume, rate),
    tone: (frequency: number, duration: number, volume: number): void => dfTone(frequency, duration, volume),
    playMusic: (track: number, loop: boolean, volume: number): void => {
      dfMusic(0, track, loop ? 1 : 0, volume);
    },
    stopMusic: (): void => void dfMusic(1, 0, 0, 0),
    pauseMusic: (paused: boolean): void => void dfMusic(2, paused ? 1 : 0, 0, 0),
    setMusicVolume: (volume: number): void => void dfMusic(3, volume, 0, 0),
    setMasterVolume: (volume: number): void => void dfMusic(4, volume, 0, 0),
  };
}

export const decodeNativeSound = (mp3: Uint8Array): number => dfSound(mp3);
export const storeNativeTrack = (mp3: Uint8Array): number => dfTrack(mp3);
