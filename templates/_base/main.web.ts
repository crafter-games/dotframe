import { connectRelay } from "dotframe/src/relay-client";
import { run } from "dotframe/src/web/run";
import { WINDOW } from "./src/game";
import { createSetup } from "./src/setup";

// ?room=<name> plays online through a dotframe relay (?relay=ws://..., default the page's /relay). ?mash=<seed> lets
// a scripted player press random inputs, which is how `dotframe play --online` drives two browsers.
const params = new URLSearchParams(location.search);
const room = params.get("room");
const relay = params.get("relay") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/relay`;
const mash = params.get("mash");

// fit: "window" fills the browser window; the setup refits the canvas when its shape changes.
await run(WINDOW, createSetup({ link: room ? connectRelay(relay, room) : null, mash: mash === null ? null : Number(mash) }), { fit: "window" });
