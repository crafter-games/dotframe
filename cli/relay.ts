import type { Server, ServerWebSocket } from "bun";

// Netplay relay: pairs two clients per room and forwards every message to the other one, untouched. Rooms come
// from the URL (?room=...); in Discord the room is the Activity instance id. Same protocol as connectRelay.
// Reconnects: ?slot=<n> asks for the slot a client had, and ?client=<id> lets a new socket replace one the relay
// still thinks is open (a phone that changed networks), without the peer hearing that it left.
interface Peer {
  room: string;
  slot: number;
  client: string;
  want: number;
}

interface Slot {
  ws: ServerWebSocket<Peer> | null;
  client: string;
}

const emptyRoom = (): Slot[] => [
  { ws: null, client: "" },
  { ws: null, client: "" },
];

export function startRelay(port: number, log: (line: string) => void = (): void => {}): Server<Peer> {
  const rooms = new Map<string, Slot[]>();
  const send = (ws: ServerWebSocket<Peer> | null, message: object): void => {
    if (ws) ws.send(JSON.stringify(message));
  };
  // The slot this client's open socket holds, else the slot it asks for if free, else any free one; -1 when full.
  const pick = (slots: Slot[], client: string, want: number): number => {
    const own = client === "" ? -1 : slots.findIndex((s) => s.client === client);
    if (own >= 0) return own;
    if ((want === 0 || want === 1) && slots[want].ws === null) return want;
    return slots.findIndex((s) => s.ws === null);
  };
  return Bun.serve<Peer>({
    port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/health")) return new Response("ok");
      const room = url.searchParams.get("room") ?? "";
      const client = url.searchParams.get("client") ?? "";
      if (room === "" || room.length > 128) return new Response("room required", { status: 400 });
      if (client.length > 128) return new Response("client id too long", { status: 400 });
      const want = Number(url.searchParams.get("slot") ?? "-1");
      const slot = pick(rooms.get(room) ?? emptyRoom(), client, want);
      if (slot < 0) return new Response("room full", { status: 409 });
      if (server.upgrade(request, { data: { room, slot, client, want } })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        const slots = rooms.get(ws.data.room) ?? emptyRoom();
        // Two sockets can race for the same slot between fetch and open.
        const slot = pick(slots, ws.data.client, ws.data.want);
        if (slot < 0) {
          ws.close(4009, "room full");
          return;
        }
        ws.data.slot = slot;
        const previous = slots[slot].ws;
        slots[slot] = { ws, client: ws.data.client };
        rooms.set(ws.data.room, slots);
        // The old socket of a returning client closes without telling the peer it left.
        if (previous) previous.close(4000, "replaced");
        log(`join room=${ws.data.room} slot=${slot}${previous ? " (replaced)" : ""}`);
        send(ws, { t: "hello", slot });
        const other = slots[1 - slot].ws;
        if (other) {
          send(ws, { t: "peer", here: true });
          send(other, { t: "peer", here: true });
        }
      },
      message(ws, message) {
        const slots = rooms.get(ws.data.room);
        if (!slots || slots[ws.data.slot].ws !== ws) return;
        const other = slots[1 - ws.data.slot].ws;
        if (other) other.send(message);
      },
      close(ws) {
        const slots = rooms.get(ws.data.room);
        if (!slots || slots[ws.data.slot].ws !== ws) return;
        slots[ws.data.slot] = { ws: null, client: "" };
        log(`leave room=${ws.data.room} slot=${ws.data.slot}`);
        send(slots[1 - ws.data.slot].ws, { t: "peer", here: false });
        if (slots.every((s) => s.ws === null)) rooms.delete(ws.data.room);
      },
    },
  });
}
