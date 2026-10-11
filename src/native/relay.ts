// The relay transport for native builds (macOS, Windows, iOS): the same RelayLink as connectRelay on the web, over
// the native WebSocket client, polled from the game's frame because library mode (iOS) has no promises or events.
import type { InputMessage, NetMessage, RelayLink, SumMessage } from "../netplay";
import { dfWs, dfWsText } from "./ffi";

const dfWsOpen = (url: string): number => dfWsText(0, -1, url);
const dfWsState = (socket: number): number => dfWs(0, socket, 0);
const dfWsNext = (socket: number): number => dfWs(1, socket, 0);
const dfWsByte = (socket: number, index: number): number => dfWs(2, socket, index);
const dfWsPop = (socket: number): number => dfWs(3, socket, 0);
const dfWsClose = (socket: number): number => dfWs(4, socket, 0);

const STATE_OPEN = 1;
const STATE_CLOSED = 2;
const STATE_ERROR = 3;

// Loops instead of splice: scriptc cannot splice an array of a generic instantiated with unknown, and generic
// helpers must live at module scope.
function drain<T>(queue: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < queue.length; i++) out.push(queue[i]);
  queue.length = 0;
  return out;
}

// Wait between reconnect attempts after a socket that had joined the room drops.
const RETRY_MS = 1000;

// A dropped socket reconnects to the same room and slot on a later poll (status "connecting" meanwhile), as on the web.
export function connectRelayNative<A = unknown>(url: string, room: string): RelayLink<A> {
  const client = Math.random().toString(36).slice(2);
  let slot = -1;
  const dial = (): number =>
    dfWsOpen(`${url}${url.includes("?") ? "&" : "?"}room=${encodeURIComponent(room)}&client=${client}${slot >= 0 ? `&slot=${slot}` : ""}`);
  let socket = dial();
  const decoder = new TextDecoder();
  let status = socket < 0 ? "closed" : "connecting";
  let closed = false;
  let retryAt = -1;
  const app: A[] = [];
  const net: NetMessage[] = [];

  // Drains the native inbox into the game and netplay queues. Called by every read, so polling happens per frame.
  const pump = (): void => {
    if (closed) return;
    if (retryAt >= 0) {
      if (performance.now() < retryAt) return;
      retryAt = -1;
      socket = dial();
      if (socket < 0) retryAt = performance.now() + RETRY_MS;
    }
    if (socket < 0) return;
    const state = dfWsState(socket);
    if (state === STATE_CLOSED || state === STATE_ERROR) {
      // Only a socket that had joined comes back; a first connection that fails stays closed.
      if (slot < 0) {
        status = "closed";
        return;
      }
      dfWsClose(socket);
      status = "connecting";
      retryAt = performance.now() + RETRY_MS;
      return;
    }
    for (let len = dfWsNext(socket); len >= 0; len = dfWsNext(socket)) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = dfWsByte(socket, i);
      dfWsPop(socket);
      const text = decoder.decode(bytes);
      // scriptc builds a parsed value in the asserted shape and cannot re-shape it later, so each message is parsed
      // once more as its final type, chosen by its "t".
      const header = JSON.parse(text) as { t?: string; slot?: number; here?: boolean };
      if (header.t === "hello") {
        slot = header.slot ?? -1;
        status = "waiting";
      } else if (header.t === "peer") {
        status = header.here ? "paired" : "waiting";
        if (!header.here) net.length = 0;
      } else if (header.t === "input") net.push(JSON.parse(text) as InputMessage);
      else if (header.t === "sum") net.push(JSON.parse(text) as SumMessage);
      else app.push(JSON.parse(text) as A);
    }
  };
  const send = (message: unknown): void => {
    if (socket >= 0 && dfWsState(socket) === STATE_OPEN) dfWsText(1, socket, JSON.stringify(message));
  };
  return {
    room,
    status: (): string => {
      pump();
      return status;
    },
    slot: (): number => {
      pump();
      return slot;
    },
    send: (message: A): void => send(message),
    receive: (): A[] => {
      pump();
      return drain(app);
    },
    transport: {
      send: (message: NetMessage): void => send(message),
      receive: (): NetMessage[] => {
        pump();
        return drain(net);
      },
    },
    close: (): void => {
      if (socket >= 0) dfWsClose(socket);
      closed = true;
      status = "closed";
    },
  };
}

// Shares text, such as a room link: the share sheet on iOS, the clipboard on macOS and Windows.
// Returns "sheet", "clipboard" or "failed".
export function shareText(text: string): string {
  const result = dfWsText(2, -1, text);
  return result === 1 ? "sheet" : result === 2 ? "clipboard" : "failed";
}
