import { afterAll, expect, test } from "bun:test";
import { startRelay } from "../cli/relay";

const relay = startRelay(0);
afterAll(() => {
  void relay.stop(true);
});

interface Socket {
  ws: WebSocket;
  heard: { t?: string; slot?: number; here?: boolean }[];
  closed: Promise<number>;
}

async function join(query: string): Promise<Socket> {
  const ws = new WebSocket(`ws://localhost:${relay.port}/?${query}`);
  const heard: Socket["heard"] = [];
  ws.onmessage = (event): void => void heard.push(JSON.parse(String(event.data)));
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event): void => resolve(event.code);
  });
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });
  await Bun.sleep(30);
  return { ws, heard, closed };
}

test("a client that comes back asks for its slot and gets it", async () => {
  const host = await join("room=a&client=h");
  const guest = await join("room=a&client=g");
  expect(guest.heard[0]).toEqual({ t: "hello", slot: 1 });
  // Both drop; the guest is back first, and without asking it would take slot 0 and play the host's critter.
  host.ws.close();
  guest.ws.close();
  await Promise.all([host.closed, guest.closed]);
  const back = await join("room=a&client=g&slot=1");
  expect(back.heard[0]).toEqual({ t: "hello", slot: 1 });
  back.ws.close();
});

test("a new socket with the same client id replaces one the relay thinks is open, and the peer never hears it left", async () => {
  const host = await join("room=b&client=h");
  const guest = await join("room=b&client=g");
  const again = await join("room=b&client=g&slot=1");
  expect(again.heard[0]).toEqual({ t: "hello", slot: 1 });
  expect(await guest.closed).toBe(4000);
  await Bun.sleep(30);
  expect(host.heard.some((m) => m.t === "peer" && m.here === false)).toBe(false);
  // Traffic flows through the new socket.
  host.ws.send(JSON.stringify({ t: "input", now: 1 }));
  await Bun.sleep(30);
  expect(again.heard.some((m) => m.t === "input")).toBe(true);
  host.ws.close();
  again.ws.close();
});

test("a third client is turned away", async () => {
  const a = await join("room=c&client=1");
  const b = await join("room=c&client=2");
  const res = await fetch(`http://localhost:${relay.port}/?room=c&client=3`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
  expect(res.status).toBe(409);
  a.ws.close();
  b.ws.close();
});

test("relay links reconnect to the same slots after the relay restarts", async () => {
  const { connectRelay } = await import("../src/relay-client");
  const own = startRelay(0);
  const port = own.port;
  const url = `ws://localhost:${port}/`;
  const host = connectRelay(url, "d");
  await Bun.sleep(50);
  const guest = connectRelay(url, "d");
  await Bun.sleep(50);
  expect([host.slot(), guest.slot(), host.status()]).toEqual([0, 1, "paired"]);
  await own.stop(true);
  await Bun.sleep(50);
  expect(host.status()).toBe("connecting");
  const restarted = startRelay(port);
  await Bun.sleep(1300);
  expect([host.slot(), guest.slot(), host.status(), guest.status()]).toEqual([0, 1, "paired", "paired"]);
  host.close();
  guest.close();
  void restarted.stop(true);
});
