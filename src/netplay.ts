// Rollback netplay for two peers, game-agnostic (generalized from Crafter Smash). Each peer simulates every frame
// immediately, predicting the remote input as "same as the last one seen". When the real input arrives and differs,
// it restores the snapshot taken before that frame and re-simulates to the present. Local input is delayed a few
// frames to hide most of the latency, so rollbacks stay short.
//
// The relay client (web only) is in src/relay-client.
//
// Turn-based games pass `owner`: while one player owns the input (their turn), the other player's input is fed as
// neutral on both peers, so the owner never waits for the network and the other peer plays the turn back as its
// inputs arrive, without predicting it. Frames owned by NOBODY use neither input and never wait.
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
  // How many of our inputs the sender holds in a row from frame 0. Inputs are resent from there, so a gap in the
  // link (a dropped socket, a relay that lost messages while a peer was away) heals once messages flow again.
  got?: number;
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
  // Wall clock in ms (performance.now). With it the round trip is measured in time, so a peer that stalls does not
  // read a shorter round trip, think it is further ahead and stall again. Without it the round trip counts frames.
  clock?: () => number;
  // Turn-based games: the port whose input the next step uses, read from the sim's current state; -1 when both
  // matter, NOBODY when neither does (a countdown, a cutscene). Inputs that do not count are fed as `neutral`.
  owner?: () => number;
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
  // Highest frame below which the state is final: both inputs known, or the remote one replaced by ownership.
  confirmedFrame: () => number;
  // This peer's checksum after simulating `frame`, final once frame < confirmedFrame().
  sumAt: (frame: number) => number | undefined;
  stats: () => RollbackStats;
}

// `owner` value for frames that use neither input: both peers run them without the network.
export const NOBODY = 2;

const SUM_EVERY = 30;
// Weight of each new sample in the round-trip and lead averages (an exponential moving average over about 10 ticks).
const SMOOTHING = 0.1;
const FRAME_MS = 1000 / 60;
// Frames of estimated lead before a peer waits for the other. One frame was inside link jitter: both peers kept
// reading themselves ahead and stalled every few frames.
const AHEAD_TOLERANCE = 2;
// Inputs resent with every message beyond what the peer reports holding, against jitter in `got`.
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
  // Every frame below this has a final state: its remote input is confirmed or does not count (ownership).
  let final = inputDelay;
  // Our inputs the peer holds in a row, from its latest `got`; -1 until a peer that reports it answers.
  let peerGot = -1;
  // Port that owned each simulated frame, -1 for both.
  const ownerAt: number[] = [];
  const owner = options.owner;
  let peerNow = 0;
  let rtt = 0;
  let ahead = 0;
  let sentSums = 0;
  const clock = options.clock;
  // When each frame number was first sent as `now`; the peer echoes the newest one back as `ack`.
  const sentAt: (number | undefined)[] = [];
  const stats: RollbackStats = { frame: 0, rollbacks: 0, longestRollback: 0, stalls: 0, desync: -1, rtt: 0, ahead: 0, tickMs: 0 };

  for (let f = 0; f < inputDelay; f++) {
    local[f] = neutral;
    remote[f] = neutral;
  }

  // A remote input that does not count cannot mispredict.
  // Whether a port's input feeds a frame with owner `o`.
  const counts = (o: number, port: number): boolean => o !== NOBODY && o !== 1 - port;
  const mispredicted = (f: number, value: number): boolean => counts(ownerAt[f], remotePort) && used[f] !== value;

  // A frame the local port owned is final once every frame before it is: its owner was read from a final state.
  const advanceFinal = (): void => {
    while (final < frame && (final < confirmed || !counts(ownerAt[final], remotePort))) final += 1;
  };

  const remoteFor = (f: number): number => {
    if (f < confirmed) return remote[f];
    return confirmed > 0 ? remote[confirmed - 1] : neutral;
  };

  const simulate = (f: number): void => {
    snapshots[f] = sim.save();
    const o = owner ? owner() : -1;
    ownerAt[f] = o;
    const inputs = [neutral, neutral];
    inputs[localPort] = counts(o, localPort) ? (local[f] ?? neutral) : neutral;
    const r = remoteFor(f);
    inputs[remotePort] = counts(o, remotePort) ? r : neutral;
    used[f] = r;
    sim.step(inputs);
    sums[f] = sim.checksum();
    // Old snapshots are never rolled back to.
    const drop = f - maxRollback - 2;
    if (drop >= 0) snapshots[drop] = undefined;
  };

  const compareSums = (): void => {
    for (const [f, sum] of peerSums) {
      if (f >= final || f >= frame) continue;
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
        const sent = sentAt[message.ack];
        const sample = clock && sent !== undefined ? (clock() - sent) / FRAME_MS : frame - message.ack;
        rtt = rtt * (1 - SMOOTHING) + Math.max(0, sample) * SMOOTHING;
      }
      if (message.got !== undefined && message.got > peerGot) peerGot = message.got;
      for (let i = 0; i < message.inputs.length; i++) {
        const f = message.from + i;
        if (f < confirmed) continue;
        if (f !== confirmed) break;
        remote[f] = message.inputs[i];
        confirmed = f + 1;
        if (f < frame && mispredicted(f, remote[f]) && f < rollbackTo) rollbackTo = f;
      }
    }
    // Frames after the last confirmed one were predicted from it; a new confirmation can change them too.
    for (let f = confirmed; f < frame && rollbackTo === frame; f++) if (mispredicted(f, remoteFor(f))) rollbackTo = f;

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
    advanceFinal();
  };

  const send = (end: number): void => {
    const from = Math.max(0, peerGot < 0 ? end - RESEND : Math.min(peerGot, end - RESEND));
    transport.send({ t: "input", now: frame, ack: peerNow, got: confirmed, from, inputs: local.slice(from, end) });
  };

  const step = (localInput: number): boolean => {
    if (clock && sentAt[frame] === undefined) sentAt[frame] = clock();
    // Acks trail by one round trip; ten seconds back is never echoed again.
    if (frame >= 600) sentAt[frame - 600] = undefined;
    settle();
    // Wait rather than predict too far, or run ahead of a slower peer. The peer's last reported frame is one trip
    // old; its current frame is about that plus half the round trip. Waiting on the raw gap instead would make both
    // peers wait for each other and play at round-trip speed.
    ahead = ahead * (1 - SMOOTHING) + (frame - (peerNow + rtt / 2)) * SMOOTHING;
    // With ownership, a final state names who plays next: the local owner never waits, and a remote owner's turn
    // is played back as it arrives instead of predicted (a prediction there is wrong as soon as they move).
    const next = owner && final === frame ? owner() : -1;
    const watching = next === remotePort && frame >= confirmed;
    const free = next === localPort || next === NOBODY;
    if (watching || (!free && (frame - final >= maxRollback || ahead > AHEAD_TOLERANCE))) {
      if (!watching) stats.stalls += 1;
      send(frame + inputDelay);
      return false;
    }
    local[frame + inputDelay] = localInput;
    send(frame + inputDelay + 1);
    simulate(frame);
    frame += 1;
    advanceFinal();
    while (sentSums + SUM_EVERY < final && sentSums + SUM_EVERY < frame) {
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
    confirmedFrame: (): number => final,
    sumAt: (f: number): number | undefined => sums[f],
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
