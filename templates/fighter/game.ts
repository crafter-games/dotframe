// A two-player box fighter. All simulation state lives in Game and changes only in step(), so dotframe can
// replay, snapshot, and roll it back. render() only reads it.
import type { Draw2D } from "dotframe/src/draw2d";
import type { Input } from "dotframe/src/input";

export const WINDOW = { width: 960, height: 540, title: "__NAME__" };
export const PLAYERS = 2;

const LEFT = 1;
const RIGHT = 2;
const JUMP = 4;
const ATTACK = 8;
const GROUND = 440;
// The input bit a released mouse or touch press sets for player 1 (attacks); see src/setup.ts.
export const POINTER_BIT = ATTACK;
const GRAVITY = 0.8;
const SPEED = 5;
const JUMP_SPEED = 15;
const STOCKS = 3;

export interface Fighter {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  damage: number;
  stocks: number;
  cooldown: number;
  stun: number;
  held: number;
}

export interface Game {
  frame: number;
  seed: number;
  fighters: Fighter[];
  // Index of the winner, or -1 while the match runs.
  winner: number;
}

const fighter = (x: number, facing: number): Fighter => ({ x, y: GROUND, vx: 0, vy: 0, facing, damage: 0, stocks: STOCKS, cooldown: 0, stun: 0, held: 0 });

export function createGame(seed: number): Game {
  return { frame: 0, seed: seed >>> 0, fighters: [fighter(300, 1), fighter(660, -1)], winner: -1 };
}

export function encode(input: unknown): number {
  const i = input as { left?: boolean; right?: boolean; jump?: boolean; attack?: boolean };
  return (i.left ? LEFT : 0) | (i.right ? RIGHT : 0) | (i.jump ? JUMP : 0) | (i.attack ? ATTACK : 0);
}

export function keyInput(input: Input, keys: number[]): number {
  return keys.reduce((bits: number, key: number, i: number): number => (input.down(key) ? bits | (1 << i) : bits), 0);
}

export function randomInput(next: () => number): number {
  return (next() < 0.4 ? LEFT : next() < 0.6 ? RIGHT : 0) | (next() < 0.15 ? JUMP : 0) | (next() < 0.3 ? ATTACK : 0);
}

export function step(game: Game, inputs: number[]): void {
  if (game.winner >= 0) return;
  game.frame += 1;
  game.fighters.forEach((f: Fighter, i: number): void => {
    const other = game.fighters[1 - i];
    const bits = inputs[i] ?? 0;
    const pressed = bits & ~f.held;
    f.held = bits;
    if (f.stun > 0) f.stun -= 1;
    else {
      const move = (bits & RIGHT ? 1 : 0) - (bits & LEFT ? 1 : 0);
      f.vx = move * SPEED;
      if (move !== 0) f.facing = move;
      if (pressed & JUMP && f.y >= GROUND) f.vy = -JUMP_SPEED;
      if (pressed & ATTACK && f.cooldown === 0) {
        f.cooldown = 20;
        const dx = other.x - f.x;
        if (Math.sign(dx) === f.facing && Math.abs(dx) < 70 && Math.abs(other.y - f.y) < 60) {
          other.damage += 8;
          other.vx = f.facing * (4 + other.damage * 0.12);
          other.vy = -(5 + other.damage * 0.08);
          other.stun = 15;
        }
      }
    }
    if (f.cooldown > 0) f.cooldown -= 1;
    f.vy += GRAVITY;
    f.x += f.vx;
    f.y = Math.min(GROUND, f.y + f.vy);
    if (f.y >= GROUND) f.vy = 0;
    if (f.x < -100 || f.x > WINDOW.width + 100) {
      f.stocks -= 1;
      // Field by field: scriptc compiles records, not Object.assign.
      f.x = WINDOW.width / 2;
      f.y = GROUND;
      f.vx = 0;
      f.vy = 0;
      f.damage = 0;
      f.cooldown = 0;
      f.stun = 0;
      f.held = 0;
      if (f.stocks === 0) game.winner = 1 - i;
    }
  });
}

export function checksum(game: Game): number {
  let h = 2166136261 ^ game.frame;
  for (const f of game.fighters) for (const v of [f.x, f.y, f.vx, f.vy, f.damage, f.stocks]) h = Math.imul(h ^ Math.round(v * 100), 16777619);
  return h >>> 0;
}

export function state(game: Game): unknown {
  return { frame: game.frame, winner: game.winner, fighters: game.fighters.map(({ x, y, damage, stocks }) => ({ x: Math.round(x), y: Math.round(y), damage, stocks })) };
}

export function snapshot(game: Game): Game {
  return structuredClone(game);
}

const COLORS = ["#ff5a5f", "#3fa7ff"];

export function render(game: Game, draw: Draw2D): void {
  draw.setFillStyle("#14121f");
  draw.fillRect(0, 0, WINDOW.width, WINDOW.height);
  draw.setFillStyle("#3a3654");
  draw.fillRect(80, GROUND + 30, WINDOW.width - 160, 20);
  game.fighters.forEach((f: Fighter, i: number): void => {
    draw.setFillStyle(f.stun > 0 ? "#ffffff" : COLORS[i]);
    draw.fillRect(f.x - 20, f.y - 30, 40, 60);
    draw.setFillStyle("#ffffff");
    draw.fillRect(f.x + f.facing * 14 - 4, f.y - 18, 8, 8);
    // HUD: damage bar and stocks, no fonts needed.
    const hx = i === 0 ? 40 : WINDOW.width - 240;
    draw.setFillStyle("#2a2740");
    draw.fillRect(hx, 30, 200, 12);
    draw.setFillStyle(COLORS[i]);
    draw.fillRect(hx, 30, Math.min(200, f.damage), 12);
    for (let s = 0; s < f.stocks; s++) draw.fillRect(hx + s * 18, 50, 12, 12);
  });
}
