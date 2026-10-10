// Menus that draw and hit-test from one layout, so a button's rectangle exists once. Buttons and arrow rows
// (prev, value, next), focus for keyboard and gamepad, and taps from mouse or touch in logical coordinates.
import type { Draw2D } from "./draw2d";
import type { Input } from "./input";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UiItem {
  id: string;
  kind: "button" | "row";
  label: string;
  // Rows show a value between their arrows.
  value: string;
  disabled: boolean;
  rect: Rect;
}

export interface UiSpec {
  id: string;
  kind: "button" | "row";
  label: string;
  value?: string;
  disabled?: boolean;
}

// "prev" and "next" are a row's arrow zones (the outer fifth on each side); everything else is "body".
export interface UiHit {
  id: string;
  part: "body" | "prev" | "next";
}

export interface ColumnArea {
  x: number;
  y: number;
  width: number;
  itemHeight: number;
  gap: number;
}

// Lays items out top to bottom. Recompute it whenever labels or values change; it is cheap.
export function column(specs: UiSpec[], area: ColumnArea): UiItem[] {
  const items: UiItem[] = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    items.push({
      id: s.id,
      kind: s.kind,
      label: s.label,
      value: s.value ?? "",
      disabled: s.disabled === true,
      rect: { x: area.x, y: area.y + i * (area.itemHeight + area.gap), w: area.width, h: area.itemHeight },
    });
  }
  return items;
}

export function hit(items: UiItem[], x: number, y: number): UiHit | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = it.rect;
    if (it.disabled || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    if (it.kind === "row") {
      const zone = r.w / 5;
      if (x < r.x + zone) return { id: it.id, part: "prev" };
      if (x > r.x + r.w - zone) return { id: it.id, part: "next" };
    }
    return { id: it.id, part: "body" };
  }
  return null;
}

// Next enabled item in direction delta (+1 down, -1 up), wrapping; the first enabled item when focus is unknown.
export function moveFocus(items: UiItem[], focus: string, delta: number): string {
  if (items.length === 0) return focus;
  let index = -1;
  for (let i = 0; i < items.length; i++) if (items[i].id === focus) index = i;
  for (let step = 1; step <= items.length; step++) {
    const i = (((index < 0 ? (delta > 0 ? -1 : 0) : index) + step * delta) % items.length + items.length) % items.length;
    if (!items[i].disabled) return items[i].id;
  }
  return focus;
}

export interface UiStyle {
  // A CSS font for draw.setFont; the family must be registered with draw.addFont.
  font: string;
  fill: string;
  focusFill: string;
  text: string;
  disabledText: string;
  // Where a button's label sits ("center" by default); "left" also puts a row's label left and its value right,
  // for a settings list. pad is the inset from the item's edge (12 by default).
  align?: "left" | "center";
  pad?: number;
}

export const DEFAULT_STYLE: UiStyle = { font: "24px sans-serif", fill: "#24213a", focusFill: "#3d3866", text: "#ffffff", disabledText: "#77748f" };

export function drawUi(draw: Draw2D, items: UiItem[], focus: string, style: UiStyle = DEFAULT_STYLE): void {
  draw.setFont(style.font);
  draw.setTextBaseline("middle");
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = it.rect;
    draw.setFillStyle(it.id === focus && !it.disabled ? style.focusFill : style.fill);
    draw.fillRect(r.x, r.y, r.w, r.h);
    draw.setFillStyle(it.disabled ? style.disabledText : style.text);
    const cy = r.y + r.h / 2;
    const pad = style.pad ?? 12;
    if (style.align === "left") {
      draw.setTextAlign("left");
      draw.fillText(it.label, r.x + pad, cy);
      if (it.kind === "row") {
        draw.setTextAlign("right");
        draw.fillText(`<  ${it.value}  >`, r.x + r.w - pad, cy);
      }
      continue;
    }
    if (it.kind === "row") {
      draw.setTextAlign("left");
      draw.fillText("<", r.x + 12, cy);
      draw.setTextAlign("right");
      draw.fillText(">", r.x + r.w - 12, cy);
      draw.setTextAlign("center");
      draw.fillText(it.value === "" ? it.label : `${it.label}: ${it.value}`, r.x + r.w / 2, cy);
    } else {
      draw.setTextAlign("center");
      draw.fillText(it.label, r.x + r.w / 2, cy);
    }
  }
}

// Maps the window-normalized pointer ([0, 1] across the window) to game coordinates, for example undoing an
// aspect letterbox: (nx, ny) => ({ x: nx * logicalWidth - offsetX, y: ny * logicalHeight - offsetY }).
export type PointerMap = (nx: number, ny: number) => { x: number; y: number };

export interface Tap {
  x: number;
  y: number;
}

export interface Tapper {
  // Call once per step. Returns a tap on the step the press is released, at the release point.
  update: (input: Input) => Tap | null;
  // Ignore input until every button and finger is up: call it on a screen change so the press that caused it does
  // not also count on the next screen.
  disarm: () => void;
}

function pressed(input: Input): { down: boolean; nx: number; ny: number } {
  const touches = input.touches();
  if (touches.length > 0) return { down: true, nx: touches[0].x, ny: touches[0].y };
  const p = input.pointer();
  return { down: p.buttons !== 0, nx: p.x, ny: p.y };
}

export function createTap(map: PointerMap): Tapper {
  let armed = true;
  let wasDown = false;
  let last = { x: 0, y: 0 };
  return {
    update: (input: Input): Tap | null => {
      const now = pressed(input);
      if (now.down) last = map(now.nx, now.ny);
      if (!armed) {
        if (!now.down) armed = true;
        wasDown = false;
        return null;
      }
      const tap = wasDown && !now.down ? { x: last.x, y: last.y } : null;
      wasDown = now.down;
      return tap;
    },
    disarm: (): void => {
      armed = false;
      wasDown = false;
    },
  };
}

export interface ReleaseGate {
  // True once nothing has been held since the last disarm().
  ready: (input: Input) => boolean;
  disarm: () => void;
}

// Arm-after-release for gameplay: disarm when a match starts, and read game input only once ready() is true, so the
// click or tap that pressed START does not keep going into the match (and, say, charge a shot).
export function createReleaseGate(): ReleaseGate {
  let armed = true;
  return {
    ready: (input: Input): boolean => {
      if (!armed && !pressed(input).down) armed = true;
      return armed;
    },
    disarm: (): void => {
      armed = false;
    },
  };
}
