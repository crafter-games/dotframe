// Web only: a WebSocket to a `dotframe relay serve` relay. Native and iOS builds have no WebSocket, so this lives
// apart from src/netplay, which every target compiles.
import type { NetMessage, RelayLink } from "./netplay";

// Wait between reconnect attempts after a socket that had joined the room drops.
const RETRY_MS = 1000;

// Splits relay traffic into game messages and netplay messages. A dropped socket reconnects to the same room and
// slot (status "connecting" meanwhile); netplay resends whatever the gap lost.
export function connectRelay<A = unknown>(url: string, room: string): RelayLink<A> {
  const client = Math.random().toString(36).slice(2);
  let status = "connecting";
  let slot = -1;
  let closed = false;
  const app: A[] = [];
  const net: NetMessage[] = [];
  let socket: WebSocket;
  const open = (): void => {
    const query = `room=${encodeURIComponent(room)}&client=${client}${slot >= 0 ? `&slot=${slot}` : ""}`;
    const ws = new WebSocket(`${url}${url.includes("?") ? "&" : "?"}${query}`);
    socket = ws;
    ws.onmessage = (event: MessageEvent): void => {
      if (ws !== socket) return;
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
    ws.onclose = (): void => {
      if (ws !== socket) return;
      // Only a socket that had joined comes back; a first connection that fails stays closed.
      if (closed || slot < 0) {
        status = "closed";
        return;
      }
      status = "connecting";
      setTimeout(() => {
        if (!closed) open();
      }, RETRY_MS);
    };
  };
  open();
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
    close: (): void => {
      closed = true;
      status = "closed";
      socket.close();
    },
  };
}
