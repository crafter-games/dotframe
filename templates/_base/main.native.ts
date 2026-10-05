// Native entry for dotframe build macos|windows. The CLI stages it with the engine and compiles it with scriptc.
// DOTFRAME_ROOM plays online through a relay (DOTFRAME_RELAY, default the local relay), DOTFRAME_MASH scripts player
// 1, and DOTFRAME_PROBE is where dotframe play --online --native reads this peer's checksums.
import { writeFileSync } from "node:fs";
import { connectRelayNative } from "dotframe/src/native/relay";
import type { Frame } from "dotframe/src/gpu";
import { run } from "dotframe/src/native/run";
import type { Platform } from "dotframe/src/platform";
import type { ProbeState } from "dotframe/src/probe";
import { WINDOW } from "./src/game";
import { createSetup } from "./src/setup";

const room = process.env.DOTFRAME_ROOM ?? "";
const relay = process.env.DOTFRAME_RELAY ?? "ws://localhost:8787";
const mash = process.env.DOTFRAME_MASH ?? "";
const probeFile = process.env.DOTFRAME_PROBE ?? "";
let written = -1;

const setup = createSetup({
  link: room === "" ? null : connectRelayNative(relay, room),
  mash: mash === "" ? null : Number(mash),
  onProbe: (state: ProbeState): void => {
    // Every 30 confirmed frames is enough for the CLI, which compares every 30th checksum.
    if (probeFile === "" || state.confirmed === 0 || state.confirmed - written < 30) return;
    written = state.confirmed;
    writeFileSync(probeFile, JSON.stringify(state));
  },
});

// run() takes (platform: Platform) => Frame. Pass a function of exactly that type: scriptc cannot convert a function
// value whose parameter type differs (setup takes the narrower SetupPlatform), though it can pass a wider argument.
await run(WINDOW, (platform: Platform): Frame => setup(platform));
