import type { Audio } from "./audio";
import type { Draw2D } from "./draw2d";
import type { RenderGpu, WindowOptions } from "./gpu";

// The contract a game exposes to the dotframe CLI (sim, snap, replay, desync). A game exports one Sim as the
// default export of the module named by "sim" in dotframe.json.

export type LoadBytes = (path: string) => Promise<Uint8Array>;

export interface SimPlatform {
  gpu: RenderGpu;
  load: LoadBytes;
  // True when no frame will ever be shown (sim, replay, desync); assets can be skipped.
  headless: boolean;
  // Present when frames will be drawn (snap): the Draw2D render() receives, so fonts can be registered on it.
  draw?: Draw2D;
  audio?: Audio;
}

export interface SimRun {
  // Resolves once assets are loaded; headless runs may resolve immediately.
  ready: Promise<void>;
  start: (seed: number, options: Record<string, unknown>) => void;
  // One fixed simulation step with one encoded input per player.
  step: (inputs: number[]) => void;
  // A number that changes whenever simulation state changes; peers compare it frame by frame.
  checksum: () => number;
  // A small JSON summary for agents (positions, damage, stocks, winner).
  state: () => unknown;
  over: () => boolean;
  save: () => unknown;
  restore: (snapshot: unknown) => void;
  // Optional: the whole simulation state as a plain object graph. desync walks it at checkpoints and reports the
  // first differing path, which catches state the checksum does not cover.
  inspect?: () => unknown;
  // Optional: draws the current frame; must not change simulation state.
  render?: (draw: Draw2D) => void;
}

export interface Sim {
  players: number;
  window: WindowOptions;
  // Default options merged under --options.
  options: Record<string, unknown>;
  // Turns a JSON input (game-defined object) into the number passed to step.
  encode: (input: unknown) => number;
  // The encoded "nothing pressed" input, used before the first input and as the netplay prediction seed.
  neutral: number;
  // A random input, for mashing scripts. next() returns [0, 1).
  random: (next: () => number) => number;
  create: (platform: SimPlatform) => SimRun;
}

export function defineSim(sim: Sim): Sim {
  return sim;
}
