// Native platform pieces shared by the executable loop (run.ts) and the library-mode runtime (library.ts).
// Everything here is synchronous so it also compiles in scriptc library mode, where promises are unavailable.
import type { AudioPlayer } from "../audio";
import type { Color, Draw, PipelineOptions, RenderGpu, Texture } from "../gpu";
import { type Input, keyScancodes, type Look, type Pointer, sdlGamepadButtons, type Touch } from "../input";
import {
  dfAudioOpen,
  dfBegin,
  dfBind,
  dfBuffer,
  dfBufferDestroy,
  dfBufferWrite,
  dfDraw,
  dfEnd,
  dfPass,
  dfTarget,
  dfGamepadAxis,
  dfGamepadButton,
  dfHeight,
  dfImage,
  dfKeyDown,
  dfMouse,
  dfPipeline,
  dfMusic,
  dfVoice,
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
const PIPELINE_NO_DEPTH_WRITE = 2;

// Milliseconds the frame calls spent, summed since the last reset: begin (acquiring the target, where a host waits
// for a free drawable), encode (the draw calls) and end (submit and present), and the draw and instance counts. perf.ts reads them.
export const gpuTiming = { begin: 0, encode: 0, end: 0, draws: 0, instances: 0 };

export function createNativeRenderGpu(mobile = false): RenderGpu {
  const depthPipelines = new Set<number>();
  return {
    mobile,
    createBuffer: (usage: number, data: Uint8Array): number => {
      const buffer = dfBuffer(usage, data);
      if (buffer < 0) throw new Error(`dfBuffer failed: ${buffer}`);
      return buffer;
    },
    writeBuffer: (buffer: number, data: Uint8Array): void => dfBufferWrite(buffer, data),
    destroyBuffer: (buffer: number): void => dfBufferDestroy(buffer),
    createPipeline: (pipelineOptions: PipelineOptions): number => {
      // Instance attributes follow the vertex ones; their count and stride ride in flags bits 8-15 and 16-31.
      const instanceAttributes = pipelineOptions.instanceAttributes ?? [];
      const all = pipelineOptions.attributes.concat(instanceAttributes);
      const attributes = new Uint32Array(all.length * 3);
      for (let i = 0; i < all.length; i++) {
        const attribute = all[i];
        attributes[i * 3] = attribute.format;
        attributes[i * 3 + 1] = attribute.offset;
        attributes[i * 3 + 2] = attribute.location;
      }
      const flags =
        (pipelineOptions.depth ? PIPELINE_DEPTH : 0) |
        (pipelineOptions.blend ? PIPELINE_BLEND : 0) |
        (pipelineOptions.depthWrite === false ? PIPELINE_NO_DEPTH_WRITE : 0) |
        ((instanceAttributes.length & 255) << 8) |
        (((pipelineOptions.instanceStride ?? 0) & 65535) << 16);
      const attributeBytes = new Uint8Array(attributes.buffer, attributes.byteOffset, attributes.byteLength);
      const pipeline = dfPipeline(pipelineOptions.wgsl, pipelineOptions.stride, attributeBytes, flags);
      if (pipeline < 0) throw new Error(`dfPipeline failed: ${pipeline}`);
      if (pipelineOptions.depth) depthPipelines.add(pipeline);
      return pipeline;
    },
    bind: (pipeline: number, buffer: number, texture: number, texture2 = -1): number => {
      const group = dfBind(pipeline, buffer, texture, texture2);
      if (group < 0) throw new Error(`dfBind failed: ${group}`);
      return group;
    },
    createTexture: (width: number, height: number, rgba: Uint8Array, smooth: boolean, mipmaps = false): Texture => {
      const id = dfTexture(width, height, rgba, mipmaps ? 2 : smooth ? 1 : 0);
      if (id < 0) throw new Error(`dfTexture failed: ${id}`);
      return { id, width, height };
    },
    destroyTexture: (texture: Texture): void => dfTextureDestroy(texture.id),
    createTarget: (width: number, height: number): Texture => {
      const id = dfTarget(0, width, height, 0, 0, 0);
      if (id < 0) throw new Error(`dfTarget failed: ${id}`);
      return { id, width, height };
    },
    frame: (clear: Color, draws: Draw[], target?: Texture): void => {
      const t0 = performance.now();
      // Pipelines without depth cannot run in a pass with a depth attachment, so a frame that mixes them (a 3D
      // scene under a 2D HUD) opens a new pass, keeping what was drawn, each time the kind changes.
      let usesDepth = draws.length > 0 && depthPipelines.has(draws[0].pipeline);
      const began = target ? dfTarget(1, target.id, clear.r, clear.g, clear.b, usesDepth ? 1 : 0) : dfBegin(clear.r, clear.g, clear.b, usesDepth);
      const t1 = performance.now();
      gpuTiming.begin += t1 - t0;
      if (began !== 0) return;
      for (const draw of draws) {
        const depth = depthPipelines.has(draw.pipeline);
        if (depth !== usesDepth) {
          usesDepth = depth;
          dfPass(depth);
        }
        dfDraw(draw.pipeline, draw.bindGroup, draw.vertexBuffer, draw.indexBuffer, draw.first, draw.count, draw.instanceBuffer ?? -1, draw.instances ?? 1, draw.firstInstance ?? 0);
      }
      const t2 = performance.now();
      dfEnd();
      gpuTiming.encode += t2 - t1;
      gpuTiming.end += performance.now() - t2;
      gpuTiming.draws += draws.length;
      for (const d of draws) gpuTiming.instances += d.instances ?? 1;
    },
    aspect: (): number => dfWidth() / Math.max(dfHeight(), 1),
  };
}

// Decodes PNG bytes into a texture immediately.
export function createNativeImage(png: Uint8Array, smooth: boolean, mipmaps = false): Texture {
  const id = dfImage(png, mipmaps ? 2 : smooth ? 1 : 0);
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
    // Reading look arms mouse capture: a click in the window captures the mouse, Escape releases it.
    look: (): Look => ({ x: dfMouse(3), y: dfMouse(4) }),
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
    start: (sound: number, volume: number, rate: number, loop: boolean): number => dfVoice(0, sound, volume, rate, loop ? 1 : 0),
    setVoice: (voice: number, volume: number, pan: number): void => void dfVoice(1, voice, volume, pan, 0),
    stopVoice: (voice: number): void => void dfVoice(2, voice, 0, 0, 0),
  };
}

export const decodeNativeSound = (mp3: Uint8Array): number => dfSound(mp3);
export const storeNativeTrack = (mp3: Uint8Array): number => dfTrack(mp3);
