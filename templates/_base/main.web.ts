import { createDraw2D } from "dotframe/src/draw2d";
import type { Frame } from "dotframe/src/gpu";
import { Key } from "dotframe/src/input";
import type { Platform } from "dotframe/src/platform";
import { run } from "dotframe/src/web/run";
import { createGame, keyInput, PLAYERS, render, step, WINDOW } from "./src/game";

const STEP = 1 / 60;

await run(WINDOW, ({ gpu, input }: Platform): Frame => {
  const draw = createDraw2D(gpu, WINDOW.width, WINDOW.height);
  const game = createGame(Math.floor(Math.random() * 1e9));
  let simulated = -1;
  return (time: number): boolean => {
    if (simulated < 0) simulated = time;
    // Fixed 60 Hz steps, so the browser plays exactly what dotframe sim simulates.
    for (let n = 0; simulated + STEP <= time && n < 5; n++) {
      const keys = [keyInput(input, [Key.A, Key.D, Key.W, Key.J]), keyInput(input, [Key.Left, Key.Right, Key.Up, Key.L])];
      step(game, keys.slice(0, PLAYERS));
      simulated += STEP;
    }
    draw.begin();
    render(game, draw);
    draw.end({ r: 0, g: 0, b: 0 });
    return true;
  };
});
