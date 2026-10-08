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
  image?: (bytes: Uint8Array, smooth: boolean, mipmaps?: boolean) => Promise<Texture>;
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
  // Optional, with Sim.pilot: where player 0's eyes are and where they look (radians), for replay record --plan.
  pose?: () => Pose;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

// How replay record --plan steers player 0 in a first- or third-person game: the game owns its input encoding and
// angle conventions, the CLI only aims and walks.
export interface Pilot {
  // The yaw that faces along (dx, dz) on the ground.
  yawTo: (dx: number, dz: number) => number;
  // The most the view turns in one frame, in radians (the input's largest look value).
  turn: number;
  // One frame's input: turn the view by yaw and pitch radians (within turn), walk forward, press the use button, and
  // hold the game's named buttons (a plan step's "with", such as "crouch" or "camera").
  input: (move: { forward: boolean; yaw: number; pitch: number; use: boolean; buttons: string[] }) => number;
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
  // Optional: steering for replay record --plan (needs SimRun.pose).
  pilot?: Pilot;
}

export function defineSim(sim: Sim): Sim {
  return sim;
}
