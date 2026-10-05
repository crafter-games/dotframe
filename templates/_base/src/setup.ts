// Shared by main.web.ts and main.native.ts: keyboard and pointer to inputs, fixed 60 Hz steps, one render per frame.
import { createDraw2D } from "dotframe/src/draw2d";
import type { Frame, Setup } from "dotframe/src/gpu";
import { Key, MouseButton } from "dotframe/src/input";
import type { Platform } from "dotframe/src/platform";
import { createGame, keyInput, PLAYERS, POINTER_BIT, render, step, WINDOW } from "./game";

const STEP = 1 / 60;
// A full charge takes one second of holding.
const FULL_CHARGE = 60;

export function createSetup(): Setup {
  return ({ gpu, input, audio }: Platform): Frame => {
    // The logical canvas keeps the game's aspect and grows to fill the screen: on a 2.16 phone the game area is
    // centered with extra width around it instead of being stretched.
    const aspect = gpu.aspect();
    const logicalWidth = Math.max(WINDOW.width, Math.round(WINDOW.height * aspect));
    const logicalHeight = Math.max(WINDOW.height, Math.round(WINDOW.width / aspect));
    const offsetX = (logicalWidth - WINDOW.width) / 2;
    const offsetY = (logicalHeight - WINDOW.height) / 2;
    const draw = createDraw2D(gpu, logicalWidth, logicalHeight);
    const game = createGame(Math.floor(Math.random() * 1e9));
    let simulated = -1;
    // Hold to charge, release to act: the pattern most mouse and touch games need.
    let charge = 0;
    let wasDown = false;
    return (time: number): boolean => {
      if (simulated < 0) simulated = time;
      for (let n = 0; simulated + STEP <= time && n < 5; n++) {
        const pointer = input.pointer();
        const inside = pointer.x >= 0 && pointer.x <= 1 && pointer.y >= 0 && pointer.y <= 1;
        const down = inside && ((pointer.buttons & MouseButton.Left) !== 0 || input.touches().length > 0);
        let released = false;
        if (down) charge = Math.min(FULL_CHARGE, charge + 1);
        else if (wasDown) {
          released = true;
          // Audio is presentation, never simulation state: the pitch says how charged the release was.
          audio.tone(220 + (charge / FULL_CHARGE) * 660, 0.12, 0.25);
          charge = 0;
        }
        wasDown = down;
        const keys = [keyInput(input, [Key.A, Key.D, Key.W, Key.J]), keyInput(input, [Key.Left, Key.Right, Key.Up, Key.L])];
        if (released) keys[0] = keys[0] | POINTER_BIT;
        step(game, keys.slice(0, PLAYERS));
        simulated += STEP;
      }
      draw.begin();
      draw.translate(offsetX, offsetY);
      render(game, draw);
      if (charge > 0) {
        // Charge meter under the play area.
        draw.setFillStyle("#ffffff");
        draw.fillRect(20, WINDOW.height - 16, (WINDOW.width - 40) * (charge / FULL_CHARGE), 6);
      }
      draw.resetTransform();
      draw.end({ r: 0, g: 0, b: 0 });
      return true;
    };
  };
}
