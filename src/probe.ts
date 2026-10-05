// The state `dotframe play --online` reads from each browser: frame, confirmed frame, link status, and this peer's
// checksum at every 30th confirmed frame. Call update() once per fixed step; publish() exposes it as
// globalThis.__dotframe.
import type { Rollback } from "./netplay";

export interface ProbeState {
  frame: number;
  confirmed: number;
  status: string;
  sums: Record<number, number>;
}

export interface Probe {
  state: ProbeState;
  // Online: pass the rollback and the link status. Local: pass null and the frame just simulated.
  update: (rollback: Rollback | null, status: string, localFrame?: number) => void;
}

const EVERY = 30;

export function createProbe(): Probe {
  const state: ProbeState = { frame: 0, confirmed: 0, status: "local", sums: {} };
  (globalThis as { __dotframe?: ProbeState }).__dotframe = state;
  return {
    state,
    update: (rollback: Rollback | null, status: string, localFrame?: number): void => {
      state.status = status;
      if (!rollback) {
        if (localFrame !== undefined) state.frame = localFrame;
        return;
      }
      state.frame = rollback.stats().frame;
      state.confirmed = rollback.confirmedFrame();
      for (let f = EVERY; f < state.confirmed; f += EVERY) if (state.sums[f] === undefined) state.sums[f] = rollback.sumAt(f) ?? 0;
    },
  };
}

// A scripted masher for tests: a new random input every 6 frames from a seed, like the CLI's --mash.
export function createMasher(seed: number, random: (next: () => number) => number): () => number {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  let frame = 0;
  let input = 0;
  return (): number => {
    if (frame % 6 === 0) input = random(next);
    frame += 1;
    return input;
  };
}
