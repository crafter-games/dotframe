// The smallest dotframe game: two squares. All simulation state lives in Game and changes only in step(), so
// dotframe can replay, snapshot, and roll it back. render() only reads it.
import type { Draw2D } from "dotframe/src/draw2d";
import type { Input } from "dotframe/src/input";

export const WINDOW = { width: 960, height: 540, title: "__NAME__" };
export const PLAYERS = 2;

export interface Game {
  frame: number;
  players: { x: number; y: number }[];
  // Never ends; set it to a player index to finish the match.
  winner: number;
}

export function createGame(_seed: number): Game {
  return { frame: 0, players: [{ x: 300, y: 270 }, { x: 660, y: 270 }], winner: -1 };
}

// Bits: left, right, up, action.
export function encode(input: unknown): number {
  const i = input as { left?: boolean; right?: boolean; up?: boolean; action?: boolean };
  return (i.left ? 1 : 0) | (i.right ? 2 : 0) | (i.up ? 4 : 0) | (i.action ? 8 : 0);
}

export function keyInput(input: Input, keys: number[]): number {
  return keys.reduce((bits: number, key: number, i: number): number => (input.down(key) ? bits | (1 << i) : bits), 0);
}

export function randomInput(next: () => number): number {
  return Math.floor(next() * 16);
}

export function step(game: Game, inputs: number[]): void {
  game.frame += 1;
  game.players.forEach((p, i: number): void => {
    const bits = inputs[i] ?? 0;
    p.x = Math.max(20, Math.min(WINDOW.width - 20, p.x + (bits & 2 ? 4 : 0) - (bits & 1 ? 4 : 0)));
    p.y = Math.max(20, Math.min(WINDOW.height - 20, p.y - (bits & 4 ? 4 : 0) + 1));
  });
}

export function checksum(game: Game): number {
  let h = 2166136261 ^ game.frame;
  for (const p of game.players) h = Math.imul(Math.imul(h ^ p.x, 16777619) ^ p.y, 16777619);
  return h >>> 0;
}

export function state(game: Game): unknown {
  return game;
}

export function snapshot(game: Game): Game {
  return structuredClone(game);
}

export function render(game: Game, draw: Draw2D): void {
  draw.setFillStyle("#101018");
  draw.fillRect(0, 0, WINDOW.width, WINDOW.height);
  game.players.forEach((p, i: number): void => {
    draw.setFillStyle(i === 0 ? "#ff5a5f" : "#3fa7ff");
    draw.fillRect(p.x - 20, p.y - 20, 40, 40);
  });
}
