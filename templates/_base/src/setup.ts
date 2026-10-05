// Shared by main.web.ts and main.native.ts: keyboard and pointer to inputs, fixed 60 Hz steps, one render per frame.
// Online, the same steps go through dotframe's rollback netplay instead of straight to step().
import { createDraw2D } from "dotframe/src/draw2d";
import type { AudioPlayer } from "dotframe/src/audio";
import type { Frame, RenderGpu } from "dotframe/src/gpu";
import type { Input } from "dotframe/src/input";
import { Key, MouseButton } from "dotframe/src/input";
import { createRollback, type RelayLink, type Rollback } from "dotframe/src/netplay";
import { createMasher, createProbe, type ProbeState } from "dotframe/src/probe";
import { checksum, createGame, type Game, keyInput, PLAYERS, POINTER_BIT, randomInput, render, restore, snapshot, step, WINDOW } from "./game";

export interface SetupOptions {
  // An open relay link plays online as the slot the relay assigns; null plays locally.
  link: RelayLink | null;
  // A seed makes player 1 a scripted masher (tests); null reads the keyboard and pointer.
  mash: number | null;
  // Called after each step with the probe state: the web publishes it as globalThis.__dotframe, native builds write
  // it to a file for dotframe play --native. Required, not optional: scriptc cannot represent an optional function.
  onProbe: (state: ProbeState) => void;
}


const STEP = 1 / 60;
// A full charge takes one second of holding.
const FULL_CHARGE = 60;

// What setup needs from a platform: the async web and native platforms and iOS's library platform all have it.
export interface SetupPlatform {
  gpu: RenderGpu;
  input: Input;
  audio: AudioPlayer;
}

export function createSetup(options: SetupOptions): (platform: SetupPlatform) => Frame {
  return ({ gpu, input, audio }: SetupPlatform): Frame => {
    // The logical canvas keeps the game's aspect and grows to fill the screen: on a 2.16 phone the game area is
    // centered with extra width around it instead of being stretched.
    // Recomputed when the surface changes shape (a resizable window, run(..., { fit: "window" }) on the web).
    let aspect = 0;
    let offsetX = 0;
    let offsetY = 0;
    const draw = createDraw2D(gpu, WINDOW.width, WINDOW.height);
    const fit = (): void => {
      const now = gpu.aspect();
      if (now === aspect) return;
      aspect = now;
      const logicalWidth = Math.max(WINDOW.width, Math.round(WINDOW.height * aspect));
      const logicalHeight = Math.max(WINDOW.height, Math.round(WINDOW.width / aspect));
      offsetX = (logicalWidth - WINDOW.width) / 2;
      offsetY = (logicalHeight - WINDOW.height) / 2;
      draw.resize(logicalWidth, logicalHeight);
    };
    // Online peers must start from the same state, so the seed is fixed there.
    const game: Game = createGame(options.link ? 1 : Math.floor(Math.random() * 1e9));
    let rollback: Rollback | null = null;
    const mash = options.mash === null ? null : createMasher(options.mash, randomInput);
    // What dotframe play --online reads from each browser.
    const probe = createProbe();
    let localFrame = 0;
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
        if (mash) keys[0] = mash();
        const link = options.link;
        if (link) {
          if (!rollback && link.status() === "paired") {
            rollback = createRollback({
              sim: {
                step: (inputs: number[]): void => step(game, inputs),
                save: (): Game => snapshot(game),
                restore: (saved: Game): void => restore(game, saved),
                checksum: (): number => checksum(game),
              },
              transport: link.transport,
              localPort: link.slot(),
              neutral: 0,
              inputDelay: 2,
              maxRollback: 20,
            });
          }
          // Online, each browser controls its own player with player 1's keys.
          if (rollback) rollback.tick(keys[0]);
          probe.update(rollback, link.status());
          options.onProbe(probe.state);
        } else {
          step(game, keys.slice(0, PLAYERS));
          localFrame += 1;
          probe.update(null, "local", localFrame);
          options.onProbe(probe.state);
        }
        simulated += STEP;
      }
      fit();
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
