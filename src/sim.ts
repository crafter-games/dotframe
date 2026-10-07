import type { Audio } from "./audio";
import type { Draw2D } from "./draw2d";
import type { Color, RenderGpu, Texture, WindowOptions } from "./gpu";

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
  // Present when frames will be drawn: decodes PNG or JPEG bytes into a texture for the 3D renderer or Draw2D.
  image?: (bytes: Uint8Array, smooth: boolean) => Promise<Texture>;
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
  // Optional: draws the current frame; must not change simulation state. It must also draw with a stub Draw2D
  // that renders nothing: desync calls it that way to prove rendering leaves the simulation alone, so a render
  // that skips itself without a real draw makes that check blind.
  render?: (draw: Draw2D) => void;
}

export interface Sim {
  players: number;
  window: WindowOptions;
  // Clear color for frames drawn by snap; black when left out. A 3D game sets its sky or fog color.
  clear?: Color;
  // Default options merged under --options.
  options: Record<string, unknown>;
  // Turns a JSON input (game-defined object) into the number passed to step.
  encode: (input: unknown) => number;
  // The encoded "nothing pressed" input, used before the first input and as the netplay prediction seed.
  neutral: number;
  // A random input, for mashing scripts. next() returns [0, 1).
  random: (next: () => number) => number;
  create: (platform: SimPlatform) => SimRun;
  // Optional: the most frames the game's netplay can roll back. desync warns when a link needs more.
  rollbackWindow?: number;
}

export function defineSim(sim: Sim): Sim {
  return sim;
}
