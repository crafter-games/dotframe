import type { Server, ServerWebSocket } from "bun";

// Netplay relay: pairs two clients per room and forwards every message to the other one, untouched. Rooms come
// from the URL (?room=...); in Discord the room is the Activity instance id. Same protocol as connectRelay.
interface Peer {
  room: string;
  slot: number;
}

export function startRelay(port: number, log: (line: string) => void = (): void => {}): Server<Peer> {
  const rooms = new Map<string, (ServerWebSocket<Peer> | null)[]>();
  const send = (ws: ServerWebSocket<Peer> | null, message: object): void => {
    if (ws) ws.send(JSON.stringify(message));
  };
  return Bun.serve<Peer>({
    port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/health")) return new Response("ok");
      const room = url.searchParams.get("room") ?? "";
      if (room === "" || room.length > 128) return new Response("room required", { status: 400 });
      const peers = rooms.get(room) ?? [null, null];
      const slot = peers[0] === null ? 0 : peers[1] === null ? 1 : -1;
      if (slot < 0) return new Response("room full", { status: 409 });
      if (server.upgrade(request, { data: { room, slot } })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        const peers = rooms.get(ws.data.room) ?? [null, null];
        // Two sockets can race for the same free slot between fetch and open.
        if (peers[ws.data.slot] !== null) {
          const other = peers[1 - ws.data.slot] === null ? 1 - ws.data.slot : -1;
          if (other < 0) {
            ws.close(4009, "room full");
            return;
          }
          ws.data.slot = other;
        }
        peers[ws.data.slot] = ws;
        rooms.set(ws.data.room, peers);
        log(`join room=${ws.data.room} slot=${ws.data.slot}`);
        send(ws, { t: "hello", slot: ws.data.slot });
        const other = peers[1 - ws.data.slot];
        if (other) {
          send(ws, { t: "peer", here: true });
          send(other, { t: "peer", here: true });
        }
      },
      message(ws, message) {
        const peers = rooms.get(ws.data.room);
        const other = peers ? peers[1 - ws.data.slot] : null;
        if (other) other.send(message);
      },
      close(ws) {
        const peers = rooms.get(ws.data.room);
        if (!peers || peers[ws.data.slot] !== ws) return;
        peers[ws.data.slot] = null;
        log(`leave room=${ws.data.room} slot=${ws.data.slot}`);
        send(peers[1 - ws.data.slot], { t: "peer", here: false });
        if (peers[0] === null && peers[1] === null) rooms.delete(ws.data.room);
      },
    },
  });
}
