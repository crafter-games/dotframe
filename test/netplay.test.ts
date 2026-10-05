import { expect, test } from "bun:test";
import { createChecksum } from "../src/checksum";
import { createRollback, type NetMessage, type NetSim, type Transport } from "../src/netplay";

// Two players on a line; input bits push them and they bounce off each other, so a wrong input changes the outcome.
interface State {
  x: number[];
  v: number[];
}

function sim(): NetSim<State> & { state: State } {
  const s: State = { x: [100, 200], v: [0, 0] };
  return {
    state: s,
    step: (inputs: number[]): void => {
      for (let p = 0; p < 2; p++) {
        s.v[p] = s.v[p] * 0.9 + ((inputs[p] & 1 ? 1 : 0) - (inputs[p] & 2 ? 1 : 0)) * 0.7;
        s.x[p] += s.v[p];
      }
      if (Math.abs(s.x[0] - s.x[1]) < 20) {
        const t = s.v[0];
        s.v[0] = s.v[1];
        s.v[1] = t;
      }
    },
    save: (): State => ({ x: s.x.slice(), v: s.v.slice() }),
    restore: (saved: State): void => {
      s.x = saved.x.slice();
      s.v = saved.v.slice();
    },
    checksum: (): number => createChecksum().add(s.x[0]).add(s.x[1]).add(s.v[0]).add(s.v[1]).value(),
  };
}

// In-memory transports; each message arrives after `latency` ticks plus up to `jitter`, in order.
function link(latency: number, jitter: number): { a: Transport; b: Transport; advance: () => void } {
  let seed = 7;
  const noise = (): number => {
    seed = (Math.imul(seed, 48271) + 1) >>> 0;
    return seed % (jitter + 1);
  };
  let now = 0;
  const queues: { at: number; message: NetMessage }[][] = [[], []];
  const endpoint = (self: number): Transport => ({
    send: (message: NetMessage): void => {
      const q = queues[1 - self];
      const last = q.length > 0 ? q[q.length - 1].at : 0;
      q.push({ at: Math.max(last, now + latency + noise()), message: JSON.parse(JSON.stringify(message)) as NetMessage });
    },
    receive: (): NetMessage[] => {
      const q = queues[self];
      const out: NetMessage[] = [];
      while (q.length > 0 && q[0].at <= now) out.push((q.shift() as { message: NetMessage }).message);
      return out;
    },
  });
  return { a: endpoint(0), b: endpoint(1), advance: (): void => void (now += 1) };
}

const FRAMES = 1200;
const DELAY = 2;
const input = (player: number, f: number): number => ((Math.floor(f / 7) * 31 + player * 17) % 5) & 3;

test("two peers over a laggy link reach the reference state with no desync", () => {
  const net = link(9, 4);
  const peers = [sim(), sim()];
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: peers[port], transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 20 }),
  );
  const frames = [0, 0];
  for (let tick = 0; tick < FRAMES * 3 && Math.min(...frames) < FRAMES; tick++) {
    for (const port of [0, 1]) if (frames[port] < FRAMES && rollbacks[port].tick(input(port, frames[port]))) frames[port] += 1;
    net.advance();
  }
  // Let the last inputs arrive and settle.
  for (let i = 0; i < 40; i++) {
    for (const r of rollbacks) r.settle();
    net.advance();
  }
  const reference = sim();
  for (let f = 0; f < FRAMES; f++) reference.step([0, 1].map((p) => (f < DELAY ? 0 : input(p, f - DELAY))));
  expect(frames).toEqual([FRAMES, FRAMES]);
  for (const r of rollbacks) {
    expect(r.stats().desync).toBe(-1);
    expect(r.stats().rollbacks).toBeGreaterThan(0);
  }
  expect(peers[0].checksum()).toBe(reference.checksum());
  expect(peers[1].checksum()).toBe(reference.checksum());
});

test("a peer whose simulation diverges is reported as a desync", () => {
  const net = link(3, 0);
  const peers = [sim(), sim()];
  // Peer 1 steps slightly differently: what a platform-dependent Math call would do.
  const step = peers[1].step;
  peers[1].step = (inputs: number[]): void => {
    step(inputs);
    peers[1].state.x[0] += 1e-3;
  };
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: peers[port], transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 20 }),
  );
  for (let tick = 0; tick < 400; tick++) {
    for (const port of [0, 1]) rollbacks[port].tick(input(port, tick));
    net.advance();
  }
  expect(rollbacks[0].stats().desync).toBeGreaterThanOrEqual(0);
});
