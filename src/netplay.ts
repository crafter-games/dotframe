// Rollback netplay for two peers, game-agnostic (generalized from Crafter Smash). Each peer simulates every frame
// immediately, predicting the remote input as "same as the last one seen". When the real input arrives and differs,
// it restores the snapshot taken before that frame and re-simulates to the present. Local input is delayed a few
// frames to hide most of the latency, so rollbacks stay short.
//
// The simulation is anything with the shape of the CLI's SimRun: step, save, restore, checksum. `dotframe desync`
// tests the same contract.

export interface NetSim<S = unknown> {
  step: (inputs: number[]) => void;
  save: () => S;
  restore: (snapshot: S) => void;
  checksum: () => number;
}

export interface InputMessage {
  t: "input";
  // The sender's current frame, and the latest `now` it has received from us (an echo, to measure the round trip).
  now: number;
  ack: number;
  // Consecutive inputs starting at frame `from`.
  from: number;
  inputs: number[];
}

export interface SumMessage {
  t: "sum";
  frame: number;
  sum: number;
}

export type NetMessage = InputMessage | SumMessage;

export interface Transport {
  send: (message: NetMessage) => void;
  // Messages received since the last call, in order.
  receive: () => NetMessage[];
}

export interface RollbackOptions<S = unknown> {
  sim: NetSim<S>;
  transport: Transport;
  // 0 or 1: which player this peer controls.
  localPort: number;
  // The encoded "nothing pressed" input.
  neutral: number;
  inputDelay: number;
  // Past this many unconfirmed frames the peer waits instead of predicting further.
  maxRollback: number;
  // Called around re-simulation, so the game can mute sound and skip effects that should play once.
  resimulating?: (active: boolean) => void;
}

export interface RollbackStats {
  frame: number;
  rollbacks: number;
  longestRollback: number;
  stalls: number;
  // First frame whose checksum differed from the peer's, or -1.
  desync: number;
  // Smoothed round trip and lead over the peer, in frames.
  rtt: number;
  ahead: number;
  // Time spent in the last tick (rollback, re-simulation and the new frame), in ms.
  tickMs: number;
}

export interface Rollback {
  // One display tick: sends local input, applies remote input, rolls back if needed, then advances a frame unless
  // too far ahead of the peer. Returns whether a frame was simulated.
  tick: (localInput: number) => boolean;
  // Applies received input and rolls back without advancing.
  settle: () => void;
  // Highest frame below which both peers' inputs are known (the state there is final).
  confirmedFrame: () => number;
  stats: () => RollbackStats;
}

const SUM_EVERY = 30;
// Weight of each new sample in the round-trip and lead averages (an exponential moving average over about 10 ticks).
const SMOOTHING = 0.1;
// Inputs resent with every message so a late peer catches up without acknowledgments.
const RESEND = 8;

export function createRollback<S>(options: RollbackOptions<S>): Rollback {
  const { sim, transport, localPort, neutral, inputDelay, maxRollback } = options;
  const remotePort = 1 - localPort;
  const local: number[] = [];
  const remote: number[] = [];
  // Remote input each simulated frame actually used, to detect mispredictions.
  const used: number[] = [];
  const snapshots: (S | undefined)[] = [];
  const sums: number[] = [];
  const peerSums = new Map<number, number>();
  let frame = 0;
  // Every remote input below this frame is known.
  let confirmed = inputDelay;
  let peerNow = 0;
  let rtt = 0;
  let ahead = 0;
  let sentSums = 0;
  const stats: RollbackStats = { frame: 0, rollbacks: 0, longestRollback: 0, stalls: 0, desync: -1, rtt: 0, ahead: 0, tickMs: 0 };

  for (let f = 0; f < inputDelay; f++) {
    local[f] = neutral;
    remote[f] = neutral;
  }

  const remoteFor = (f: number): number => {
    if (f < confirmed) return remote[f];
    return confirmed > 0 ? remote[confirmed - 1] : neutral;
  };

  const simulate = (f: number): void => {
    snapshots[f] = sim.save();
    const inputs = [neutral, neutral];
    inputs[localPort] = local[f] ?? neutral;
    const r = remoteFor(f);
    inputs[remotePort] = r;
    used[f] = r;
    sim.step(inputs);
    sums[f] = sim.checksum();
    // Old snapshots are never rolled back to.
    const drop = f - maxRollback - 2;
    if (drop >= 0) snapshots[drop] = undefined;
  };

  const compareSums = (): void => {
    for (const [f, sum] of peerSums) {
      if (f >= confirmed || f >= frame) continue;
      if (sums[f] !== sum && stats.desync < 0) stats.desync = f;
      peerSums.delete(f);
    }
  };

  const settle = (): void => {
    let rollbackTo = frame;
    for (const message of transport.receive()) {
      if (message.t === "sum") {
        peerSums.set(message.frame, message.sum);
        continue;
      }
      if (message.now >= peerNow) {
        peerNow = message.now;
        rtt = rtt * (1 - SMOOTHING) + Math.max(0, frame - message.ack) * SMOOTHING;
      }
      for (let i = 0; i < message.inputs.length; i++) {
        const f = message.from + i;
        if (f < confirmed) continue;
        if (f !== confirmed) break;
        remote[f] = message.inputs[i];
        confirmed = f + 1;
        if (f < frame && used[f] !== remote[f] && f < rollbackTo) rollbackTo = f;
      }
    }
    // Frames after the last confirmed one were predicted from it; a new confirmation can change them too.
    for (let f = confirmed; f < frame && rollbackTo === frame; f++) if (used[f] !== remoteFor(f)) rollbackTo = f;

    if (rollbackTo < frame) {
      const snapshot = snapshots[rollbackTo];
      if (snapshot !== undefined) {
        stats.rollbacks += 1;
        stats.longestRollback = Math.max(stats.longestRollback, frame - rollbackTo);
        sim.restore(snapshot);
        options.resimulating?.(true);
        for (let f = rollbackTo; f < frame; f++) simulate(f);
        options.resimulating?.(false);
      }
    }
  };

  const step = (localInput: number): boolean => {
    settle();
    // Wait rather than predict too far, or run ahead of a slower peer. The peer's last reported frame is one trip
    // old; its current frame is about that plus half the round trip. Waiting on the raw gap instead would make both
    // peers wait for each other and play at round-trip speed.
    ahead = ahead * (1 - SMOOTHING) + (frame - (peerNow + rtt / 2)) * SMOOTHING;
    if (frame - confirmed >= maxRollback || ahead > 1) {
      stats.stalls += 1;
      const from = Math.max(0, frame + inputDelay - RESEND);
      transport.send({ t: "input", now: frame, ack: peerNow, from, inputs: local.slice(from, frame + inputDelay) });
      return false;
    }
    local[frame + inputDelay] = localInput;
    const from = Math.max(0, frame + inputDelay + 1 - RESEND);
    transport.send({ t: "input", now: frame, ack: peerNow, from, inputs: local.slice(from, frame + inputDelay + 1) });
    simulate(frame);
    frame += 1;
    while (sentSums + SUM_EVERY < confirmed && sentSums + SUM_EVERY < frame) {
      sentSums += SUM_EVERY;
      transport.send({ t: "sum", frame: sentSums, sum: sums[sentSums] });
    }
    compareSums();
    stats.frame = frame;
    return true;
  };

  return {
    tick: (localInput: number): boolean => {
      const started = performance.now();
      const advanced = step(localInput);
      stats.tickMs = performance.now() - started;
      stats.rtt = rtt;
      stats.ahead = ahead;
      return advanced;
    },
    settle,
    confirmedFrame: (): number => Math.min(confirmed, frame),
    stats: (): RollbackStats => stats,
  };
}

// --- Relay client ---------------------------------------------------------------------------------------------

export interface RelayLink<A = unknown> {
  room: string;
  // "connecting", "waiting" (alone in the room), "paired", "closed".
  status: () => string;
  // 0 or 1 once the relay answers, -1 before.
  slot: () => number;
  // Game messages (lobby, picks, match start): anything that is not netplay traffic.
  send: (message: A) => void;
  receive: () => A[];
  // Netplay traffic for createRollback.
  transport: Transport;
  close: () => void;
}

// One WebSocket to a `dotframe relay serve` relay, split into game messages and netplay messages. Web only:
// native and iOS builds have no WebSocket yet.
export function connectRelay<A = unknown>(url: string, room: string): RelayLink<A> {
  const socket = new WebSocket(`${url}${url.includes("?") ? "&" : "?"}room=${encodeURIComponent(room)}`);
  let status = "connecting";
  let slot = -1;
  const app: A[] = [];
  const net: NetMessage[] = [];
  socket.onmessage = (event: MessageEvent): void => {
    const message = JSON.parse(String(event.data)) as { t?: string; slot?: number; here?: boolean };
    if (message.t === "hello") {
      slot = message.slot ?? -1;
      status = "waiting";
    } else if (message.t === "peer") {
      status = message.here ? "paired" : "waiting";
      // A peer leaving drops whatever netplay traffic was in flight.
      if (!message.here) net.length = 0;
    } else if (message.t === "input" || message.t === "sum") net.push(message as NetMessage);
    else app.push(message as A);
  };
  socket.onclose = (): void => {
    status = "closed";
  };
  const send = (message: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  return {
    room,
    status: (): string => status,
    slot: (): number => slot,
    send: (message: A): void => send(message),
    receive: (): A[] => app.splice(0, app.length),
    transport: {
      send: (message: NetMessage): void => send(message),
      receive: (): NetMessage[] => net.splice(0, net.length),
    },
    close: (): void => socket.close(),
  };
}
