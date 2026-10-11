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

// 15 ticks each way; peer 1 only gets two ticks out of three, so peer 0 has to wait for it.
function slowPeer(clocked: boolean): { rtt: number; frames: number[] } {
  const net = link(15, 0);
  let tick = 0;
  const clock = clocked ? (): number => (tick * 1000) / 60 : undefined;
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: sim(), transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 60, clock }),
  );
  for (; tick < 1800; tick++) {
    rollbacks[0].tick(input(0, tick));
    if (tick % 3 !== 2) rollbacks[1].tick(input(1, tick));
    net.advance();
  }
  return { rtt: rollbacks[0].stats().rtt, frames: rollbacks.map((r) => r.stats().frame) };
}

test("with a clock, stalls do not shrink the measured round trip", () => {
  const { rtt } = slowPeer(true);
  expect(rtt).toBeGreaterThan(28);
  expect(rtt).toBeLessThan(40);
  expect(slowPeer(false).rtt).toBeLessThan(rtt);
});

test("a peer on an equal link does not stall: both run at full speed", () => {
  const net = link(15, 12); // 200 ms of jitter, about what a Discord-proxied relay shows
  let tick = 0;
  const clock = (): number => (tick * 1000) / 60;
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: sim(), transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 60, clock }),
  );
  for (; tick < 1800; tick++) {
    for (const port of [0, 1]) rollbacks[port].tick(input(port, tick));
    net.advance();
  }
  for (const r of rollbacks) expect(r.stats().stalls).toBeLessThan(30);
});

// A link that loses everything sent between ticks `from` and `to`, like a socket that drops and reconnects.
function cutLink(latency: number, from: number, to: number): { a: Transport; b: Transport; advance: () => void } {
  const net = link(latency, 0);
  let now = 0;
  const cut = (t: Transport): Transport => ({
    send: (message: NetMessage): void => {
      if (now < from || now >= to) t.send(message);
    },
    receive: t.receive,
  });
  return {
    a: cut(net.a),
    b: cut(net.b),
    advance: (): void => {
      now += 1;
      net.advance();
    },
  };
}

test("a link that drops for three seconds heals once messages flow again", () => {
  const net = cutLink(9, 600, 780);
  const peers = [sim(), sim()];
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: peers[port], transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 20 }),
  );
  const frames = [0, 0];
  for (let tick = 0; tick < FRAMES * 3 && Math.min(...frames) < FRAMES; tick++) {
    for (const port of [0, 1]) if (frames[port] < FRAMES && rollbacks[port].tick(input(port, frames[port]))) frames[port] += 1;
    net.advance();
  }
  for (let i = 0; i < 40; i++) {
    for (const r of rollbacks) r.settle();
    net.advance();
  }
  const reference = sim();
  for (let f = 0; f < FRAMES; f++) reference.step([0, 1].map((p) => (f < DELAY ? 0 : input(p, f - DELAY))));
  expect(frames).toEqual([FRAMES, FRAMES]);
  for (const r of rollbacks) expect(r.stats().desync).toBe(-1);
  expect(peers[0].checksum()).toBe(reference.checksum());
  expect(peers[1].checksum()).toBe(reference.checksum());
});

// Turns of TURN frames: only the player with the turn moves, but both players' inputs feed the edge detection
// (like a game that tracks the previous input of every seat), so a remote input that leaked into a turn it does
// not own would change the state.
const TURN = 300;
interface TurnState {
  turn: number;
  left: number;
  x: number[];
  previous: number[];
}
function turnSim(): NetSim<TurnState> & { state: TurnState; owner: () => number } {
  let s: TurnState = { turn: 0, left: TURN, x: [0, 0], previous: [0, 0] };
  return {
    get state(): TurnState {
      return s;
    },
    owner: (): number => s.turn,
    step: (inputs: number[]): void => {
      const pressed = inputs[s.turn] & ~s.previous[s.turn];
      s.x[s.turn] += (inputs[s.turn] & 1) + (pressed & 2) * 5;
      s.previous = inputs.slice();
      s.left -= 1;
      if (s.left === 0) {
        s.turn = 1 - s.turn;
        s.left = TURN;
      }
    },
    save: (): TurnState => ({ turn: s.turn, left: s.left, x: s.x.slice(), previous: s.previous.slice() }),
    restore: (saved: TurnState): void => {
      s = { turn: saved.turn, left: saved.left, x: saved.x.slice(), previous: saved.previous.slice() };
    },
    checksum: (): number => createChecksum().add(s.turn).add(s.left).add(s.x[0]).add(s.x[1]).add(s.previous[0]).add(s.previous[1]).value(),
  };
}

test("with ownership, the player with the turn never waits on a 2-second round trip", () => {
  const net = link(60, 0); // 1 s each way
  const peers = [turnSim(), turnSim()];
  const rollbacks = [0, 1].map((port) =>
    createRollback({ sim: peers[port], transport: port === 0 ? net.a : net.b, localPort: port, neutral: 0, inputDelay: DELAY, maxRollback: 60, owner: peers[port].owner }),
  );
  const frames = [0, 0];
  // Peer 0 owns the first turn: it plays all of it in TURN ticks even though nothing arrives for a second.
  for (let tick = 0; tick < TURN; tick++) {
    for (const port of [0, 1]) if (rollbacks[port].tick(input(port, frames[port]))) frames[port] += 1;
    net.advance();
  }
  expect(frames[0]).toBe(TURN);
  expect(rollbacks[0].stats().stalls).toBe(0);
  // Peer 1 watches the turn as it arrives: never predicted, never rolled back.
  expect(frames[1]).toBeLessThan(TURN - 50);
  for (let tick = 0; tick < 20000 && Math.min(...frames) < FRAMES * 2; tick++) {
    for (const port of [0, 1]) if (frames[port] < FRAMES * 2 && rollbacks[port].tick(input(port, frames[port]))) frames[port] += 1;
    net.advance();
  }
  for (let i = 0; i < 200; i++) {
    for (const r of rollbacks) r.settle();
    net.advance();
  }
  const reference = turnSim();
  for (let f = 0; f < FRAMES * 2; f++) {
    const inputs = [0, 1].map((p) => (f < DELAY || p !== reference.owner() ? 0 : input(p, f - DELAY)));
    reference.step(inputs);
  }
  expect(frames).toEqual([FRAMES * 2, FRAMES * 2]);
  for (const r of rollbacks) {
    expect(r.stats().desync).toBe(-1);
    expect(r.stats().rollbacks).toBe(0);
  }
  expect(peers[0].checksum()).toBe(reference.checksum());
  expect(peers[1].checksum()).toBe(reference.checksum());
});
