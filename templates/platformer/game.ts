// A one-player platformer: run, jump, collect every coin. All simulation state lives in Game and changes only in
// step(), so dotframe can replay, snapshot, and roll it back. render() only reads it.
import type { Draw2D } from "dotframe/src/draw2d";
import type { Input } from "dotframe/src/input";

export const WINDOW = { width: 960, height: 540, title: "__NAME__" };
export const PLAYERS = 1;

const LEFT = 1;
const RIGHT = 2;
const JUMP = 4;
const GRAVITY = 0.7;
const SPEED = 4.5;
const JUMP_SPEED = 13;
const SIZE = 28;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PLATFORMS: Rect[] = [
  { x: 0, y: 500, w: 960, h: 40 },
  { x: 140, y: 400, w: 160, h: 16 },
  { x: 380, y: 320, w: 180, h: 16 },
  { x: 640, y: 240, w: 160, h: 16 },
  { x: 420, y: 150, w: 120, h: 16 },
];

export interface Game {
  frame: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  held: number;
  coins: { x: number; y: number; taken: boolean }[];
  // 0 once every coin is taken, -1 while playing.
  winner: number;
}

export function createGame(_seed: number): Game {
  const spots = [220, 370, 470, 290, 720, 210, 480, 120, 880, 470];
  const coins: { x: number; y: number; taken: boolean }[] = [];
  for (let i = 0; i < spots.length; i += 2) coins.push({ x: spots[i], y: spots[i + 1], taken: false });
  return { frame: 0, x: 60, y: 500 - SIZE, vx: 0, vy: 0, onGround: true, held: 0, coins, winner: -1 };
}

export function encode(input: unknown): number {
  const i = input as { left?: boolean; right?: boolean; jump?: boolean };
  return (i.left ? LEFT : 0) | (i.right ? RIGHT : 0) | (i.jump ? JUMP : 0);
}

export function keyInput(input: Input, keys: number[]): number {
  return keys.reduce((bits: number, key: number, i: number): number => (input.down(key) ? bits | (1 << i) : bits), 0);
}

export function randomInput(next: () => number): number {
  return (next() < 0.35 ? LEFT : next() < 0.75 ? RIGHT : 0) | (next() < 0.3 ? JUMP : 0);
}

export function step(game: Game, inputs: number[]): void {
  if (game.winner >= 0) return;
  game.frame += 1;
  const bits = inputs[0] ?? 0;
  const pressed = bits & ~game.held;
  game.held = bits;
  game.vx = ((bits & RIGHT ? 1 : 0) - (bits & LEFT ? 1 : 0)) * SPEED;
  if (pressed & JUMP && game.onGround) game.vy = -JUMP_SPEED;
  game.vy = Math.min(game.vy + GRAVITY, 16);
  game.x = Math.max(0, Math.min(WINDOW.width - SIZE, game.x + game.vx));
  const prevBottom = game.y + SIZE;
  game.y += game.vy;
  game.onGround = false;
  // One-way platforms: land only when falling onto the top edge.
  for (const p of PLATFORMS) {
    const overX = game.x + SIZE > p.x && game.x < p.x + p.w;
    if (overX && game.vy >= 0 && prevBottom <= p.y && game.y + SIZE >= p.y) {
      game.y = p.y - SIZE;
      game.vy = 0;
      game.onGround = true;
    }
  }
  for (const c of game.coins) {
    if (!c.taken && Math.abs(game.x + SIZE / 2 - c.x) < 22 && Math.abs(game.y + SIZE / 2 - c.y) < 22) c.taken = true;
  }
  if (game.coins.every((c) => c.taken)) game.winner = 0;
}

export function checksum(game: Game): number {
  let h = 2166136261 ^ game.frame;
  for (const v of [game.x, game.y, game.vx, game.vy, ...game.coins.map((c) => (c.taken ? 1 : 0))]) h = Math.imul(h ^ Math.round(v * 100), 16777619);
  return h >>> 0;
}

export function state(game: Game): unknown {
  return { frame: game.frame, x: Math.round(game.x), y: Math.round(game.y), coins: game.coins.filter((c) => c.taken).length, of: game.coins.length, won: game.winner === 0 };
}

export function snapshot(game: Game): Game {
  return structuredClone(game);
}

export function render(game: Game, draw: Draw2D): void {
  draw.setFillStyle("#0f1a2b");
  draw.fillRect(0, 0, WINDOW.width, WINDOW.height);
  draw.setFillStyle("#3c5a7a");
  for (const p of PLATFORMS) draw.fillRect(p.x, p.y, p.w, p.h);
  draw.setFillStyle("#ffd23f");
  for (const c of game.coins) if (!c.taken) draw.fillRect(c.x - 8, c.y - 8, 16, 16);
  draw.setFillStyle(game.winner === 0 ? "#7cff8a" : "#ff5a5f");
  draw.fillRect(game.x, game.y, SIZE, SIZE);
}
