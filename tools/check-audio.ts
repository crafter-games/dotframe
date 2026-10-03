// Verifies the mix written by examples/audio-check through SDL's disk audio driver.
// Usage: bun tools/check-audio.ts <out.raw>   (F32LE, stereo, 48 kHz)
const RATE = 48000;
const WINDOW = RATE / 20;

const bytes = new Uint8Array(await Bun.file(process.argv[2]).arrayBuffer());
const samples = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));

interface Window {
  start: number;
  rms: number;
  crossings: number;
}

const windows: Window[] = [];
for (let frame = 0; frame + WINDOW <= samples.length / 2; frame += WINDOW) {
  let sum = 0;
  let crossings = 0;
  for (let k = 0; k < WINDOW; k++) {
    const value = samples[(frame + k) * 2];
    sum += value * value;
    if (k > 0 && samples[(frame + k - 1) * 2] < 0 !== value < 0) crossings++;
  }
  windows.push({ start: frame / RATE, rms: Math.sqrt(sum / WINDOW), crossings });
}

const loud = (w: Window): boolean => w.rms > 0.003;
// Segments of consecutive loud windows, in order. Device start latency shifts the timeline, so match by sequence.
const segments: Window[][] = [];
for (const w of windows) {
  if (!loud(w)) continue;
  const last = segments[segments.length - 1];
  if (last && Math.abs(last[last.length - 1].start + WINDOW / RATE - w.start) < 1e-6) last.push(w);
  else segments.push([w]);
}

const failures: string[] = [];
const describe = (segment: Window[]): string =>
  `${segment[0].start.toFixed(2)}s-${(segment[segment.length - 1].start + 0.05).toFixed(2)}s`;
const steadyCrossings = (segment: Window[]): number[] => segment.slice(1, -1).map((w) => w.crossings);

if (segments.length !== 3) failures.push(`expected 3 sound segments (hit, tone, music), got ${segments.length}`);
const [hit, tone, music] = segments;
if (hit && (hit.length < 4 || hit.length > 7)) failures.push(`hit lasted ${describe(hit)}, expected about 0.25s`);
if (tone && !steadyCrossings(tone).every((c) => Math.abs(c - 88) <= 2)) {
  failures.push(`tone is not 880 Hz: crossings ${steadyCrossings(tone).join(",")}`);
}
if (music && (music.length < 18 || music.length > 22)) failures.push(`music lasted ${describe(music)}, expected about 1s`);
if (music && Math.abs(music[2].crossings - 26) > 2) failures.push(`music does not start on 262 Hz: ${music[2].crossings}`);
if (windows.length > 0 && loud(windows[windows.length - 1])) failures.push("mix does not end in silence after stop");

for (const segment of segments) console.log(`segment ${describe(segment)} peak rms ${Math.max(...segment.map((w) => w.rms)).toFixed(4)}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("audio mix OK: hit, 880 Hz tone, 262 Hz music, silence after stop");
