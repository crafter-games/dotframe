// Web only: a WebSocket to a `dotframe relay serve` relay. Native and iOS builds have no WebSocket, so this lives
// apart from src/netplay, which every target compiles.
import type { NetMessage, RelayLink } from "./netplay";

// Splits relay traffic into game messages and netplay messages.
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
