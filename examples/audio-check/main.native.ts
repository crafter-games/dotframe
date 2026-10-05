// Headless check of the native mixer: plays a known timeline so the output can be measured.
// Run with SDL_AUDIO_DRIVER=disk to write the mix to a file instead of a device.
import { readFileSync } from "node:fs";
import { dfAudioOpen, dfMusic, dfPlay, dfSound, dfTone, dfTrack } from "../../src/native/ffi";

const root = process.env.DF_ROOT ?? ".";
const bytes = (path: string): Uint8Array => {
  const data = readFileSync(`${root}/${path}`);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

if (dfAudioOpen() !== 0) throw new Error("audio device did not open");
const hit = dfSound(bytes("assets/audio/hit.mp3"));
const loop = dfTrack(bytes("assets/audio/loop.mp3"));
console.log(`sound ${hit} track ${loop}`);

// Timeline (seconds): 0.0 silence, 0.5 hit, 1.0 tone, 1.5 music, 2.5 stop, 3.0 end.
await wait(500);
dfPlay(hit, 1, 1);
await wait(500);
dfTone(880, 0.3, 0.3);
await wait(500);
dfMusic(0, loop, 1, 1);
await wait(1000);
dfMusic(1, 0, 0, 0);
await wait(500);
console.log("done");
