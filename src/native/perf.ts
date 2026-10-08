// Frame timing for native hosts, where `dotframe perf` cannot reach: wrap the frame function and every `every`
// frames print one line with the frame interval and the frame's CPU time (p50, p95, max, in ms), and the first
// line also carries the time from `since` to the first frame (load). Read it with the device console, e.g.
// xcrun devicectl device process launch --console.
export function timedFrame(frame: (time: number) => boolean, since: number, every = 600): (time: number) => boolean {
  const interval: number[] = [];
  const cpu: number[] = [];
  let last = -1;
  let load = -1;
  const summary = (values: number[]): string => {
    const sorted = values.slice().sort((a: number, b: number): number => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const ms = (x: number): string => (Math.round(x * 100) / 100).toString();
    return `p50 ${ms(at(0.5))} p95 ${ms(at(0.95))} max ${ms(sorted[sorted.length - 1])}`;
  };
  return (time: number): boolean => {
    const t = performance.now();
    if (load < 0) load = t - since;
    if (last >= 0) interval.push(t - last);
    last = t;
    const keep = frame(time);
    cpu.push(performance.now() - t);
    if (interval.length >= every) {
      console.log(`dotframe-perf load ${Math.round(load)} ms | interval ${summary(interval)} | cpu ${summary(cpu)} | ${interval.length} frames`);
      interval.length = 0;
      cpu.length = 0;
    }
    return keep;
  };
}
