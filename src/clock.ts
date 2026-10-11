// The time a game sees. Gaps longer than MAX_GAP (a hidden tab, a minimized window, a debugger pause) are skipped,
// so a fixed-step loop resumes where it left off instead of replaying the missed time at catch-up speed.
export const MAX_GAP = 0.25;

export function createClock(now: () => number): () => number {
  let last = now();
  let time = 0;
  return (): number => {
    const t = now();
    time += Math.min(t - last, MAX_GAP);
    last = t;
    return time;
  };
}
