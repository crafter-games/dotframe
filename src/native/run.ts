import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Audio } from "../audio";
import type { Gpu, Setup, Texture, WindowOptions } from "../gpu";
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
import { dfClose, dfOpen, dfPoll, dfPrefPath } from "./ffi";

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

  const render = createNativeRenderGpu();
  const gpu: Gpu = {
    createBuffer: render.createBuffer,
    writeBuffer: render.writeBuffer,
    destroyBuffer: render.destroyBuffer,
    createPipeline: render.createPipeline,
    bind: render.bind,
    createTexture: render.createTexture,
    destroyTexture: render.destroyTexture,
    createTarget: render.createTarget,
    frame: render.frame,
    aspect: render.aspect,
    createImage: async (png: Uint8Array, smooth: boolean, mipmaps = false): Promise<Texture> => createNativeImage(png, smooth, mipmaps),
  };
  const input = createNativeInput();
  const storage = openStorage(options.title);
  const audioReady = openNativeAudio();
  const player = createNativeAudioPlayer();
  const audio: Audio = {
    play: player.play,
    tone: player.tone,
    playMusic: player.playMusic,
    stopMusic: player.stopMusic,
    pauseMusic: player.pauseMusic,
    setMusicVolume: player.setMusicVolume,
    setMasterVolume: player.setMasterVolume,
    start: player.start,
    setVoice: player.setVoice,
    stopVoice: player.stopVoice,
    loadSound: async (mp3: Uint8Array): Promise<number> => (audioReady ? decodeNativeSound(mp3) : -1),
    loadMusic: async (mp3: Uint8Array): Promise<number> => storeNativeTrack(mp3),
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
