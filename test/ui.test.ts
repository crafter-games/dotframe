import { expect, test } from "bun:test";
import type { Input, Pointer, Touch } from "../src/input";
import { column, createReleaseGate, createTap, hit, moveFocus } from "../src/ui";

function fakeInput(): Input & { pointerState: Pointer; touchList: Touch[] } {
  const state = { pointerState: { x: 0, y: 0, buttons: 0 } as Pointer, touchList: [] as Touch[] };
  return Object.assign(state, {
    down: (): boolean => false,
    firstDown: (): number => -1,
    axis: (): number => 0,
    button: (): boolean => false,
    pointer: (): Pointer => state.pointerState,
    touches: (): Touch[] => state.touchList,
  });
}

const items = column(
  [
    { id: "start", kind: "button", label: "Start" },
    { id: "map", kind: "row", label: "Map", value: "Valley" },
    { id: "online", kind: "button", label: "Online", disabled: true },
    { id: "quit", kind: "button", label: "Quit" },
  ],
  { x: 100, y: 100, width: 400, itemHeight: 50, gap: 10 },
);

test("draw and hit-test share one layout", () => {
  expect(items[1].rect).toEqual({ x: 100, y: 160, w: 400, h: 50 });
  expect(hit(items, 300, 120)).toEqual({ id: "start", part: "body" });
  expect(hit(items, 110, 180)).toEqual({ id: "map", part: "prev" });
  expect(hit(items, 490, 180)).toEqual({ id: "map", part: "next" });
  expect(hit(items, 300, 180)).toEqual({ id: "map", part: "body" });
  // Disabled items and gaps do not hit.
  expect(hit(items, 300, 240)).toBeNull();
  expect(hit(items, 300, 155)).toBeNull();
});

test("focus skips disabled items and wraps", () => {
  expect(moveFocus(items, "map", 1)).toBe("quit");
  expect(moveFocus(items, "quit", 1)).toBe("start");
  expect(moveFocus(items, "start", -1)).toBe("quit");
  expect(moveFocus(items, "", 1)).toBe("start");
});

test("a tap fires on release, mapped to game coordinates", () => {
  const input = fakeInput();
  // A 2x letterbox: window-normalized to a 1000x500 logical canvas with the game offset by 100 px.
  const tap = createTap((nx, ny) => ({ x: nx * 1000 - 100, y: ny * 500 }));
  input.pointerState = { x: 0.5, y: 0.5, buttons: 1 };
  expect(tap.update(input)).toBeNull();
  input.pointerState = { x: 0.5, y: 0.5, buttons: 0 };
  expect(tap.update(input)).toEqual({ x: 400, y: 250 });
  expect(tap.update(input)).toBeNull();
  // Touches count too.
  input.touchList = [{ id: 1, x: 0.2, y: 0.4 }];
  expect(tap.update(input)).toBeNull();
  input.touchList = [];
  expect(tap.update(input)).toEqual({ x: 100, y: 200 });
});

test("disarm drops the press that changed screens", () => {
  const input = fakeInput();
  const tap = createTap((nx, ny) => ({ x: nx, y: ny }));
  const gate = createReleaseGate();
  input.pointerState = { x: 0.1, y: 0.1, buttons: 1 };
  tap.update(input);
  // START was pressed: the menu disarms both before the release arrives.
  tap.disarm();
  gate.disarm();
  expect(gate.ready(input)).toBe(false);
  input.pointerState = { x: 0.1, y: 0.1, buttons: 0 };
  expect(tap.update(input)).toBeNull();
  expect(gate.ready(input)).toBe(true);
  // The next full press and release counts.
  input.pointerState = { x: 0.3, y: 0.3, buttons: 1 };
  tap.update(input);
  input.pointerState = { x: 0.3, y: 0.3, buttons: 0 };
  expect(tap.update(input)).toEqual({ x: 0.3, y: 0.3 });
});
