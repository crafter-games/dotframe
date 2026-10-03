// Runtime for scriptc library mode (iOS): the native host owns the app lifecycle and event loop and calls the
// library's exported init and frame functions. The df* declarations in ffi.ts become profile callbacks the host
// registers (tools/gen-library-glue.ts), since library mode has no FFI. Library mode also has no promises, so
// loading is synchronous.
import { readFileSync } from "node:fs";
import type { AudioPlayer } from "../audio";
import type { RenderGpu, Texture, WindowOptions } from "../gpu";
import type { Input } from "../input";
import type { Storage } from "../storage";
import {
  createNativeAudioPlayer,
  createNativeImage,
  createNativeInput,
  createNativeRenderGpu,
  decodeNativeSound,
  openNativeAudio,
  storeNativeTrack,
} from "./backend";
import { dfHeight, dfOpen, dfWidth } from "./ffi";

export interface LibraryPlatform {
  gpu: RenderGpu;
  input: Input;
  audio: AudioPlayer;
  storage: Storage;
  // Surface size in pixels, to pick a logical resolution with the device's aspect ratio.
  width: number;
  height: number;
  image: (png: Uint8Array, smooth: boolean) => Texture;
  sound: (mp3: Uint8Array) => number;
  track: (mp3: Uint8Array) => number;
  readFile: (path: string) => Uint8Array;
}

// In-memory for now: library hosts pass no writable preferences path yet.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get: (key: string): string | null => values.get(key) ?? null,
    set: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
}

export function openLibraryPlatform(options: WindowOptions): LibraryPlatform {
  const status = dfOpen(options.width, options.height, options.title);
  if (status !== 0) throw new Error(`dfOpen failed: ${status}`);
  const audioReady = openNativeAudio();
  return {
    gpu: createNativeRenderGpu(),
    input: createNativeInput(),
    audio: createNativeAudioPlayer(),
    storage: memoryStorage(),
    width: dfWidth(),
    height: dfHeight(),
    image: (png: Uint8Array, smooth: boolean): Texture => createNativeImage(png, smooth),
    sound: (mp3: Uint8Array): number => (audioReady ? decodeNativeSound(mp3) : -1),
    track: (mp3: Uint8Array): number => storeNativeTrack(mp3),
    readFile: (path: string): Uint8Array => {
      const data = readFileSync(path);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
  };
}
