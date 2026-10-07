// Engine-level key ids. Each maps to a KeyboardEvent.code (web) and an SDL scancode (native).
// Codes are physical positions: Semicolon is the key right of L, which reads Ñ on a Spanish layout.

export const Key = {
  Left: 0,
  Right: 1,
  Up: 2,
  Down: 3,
  Space: 4,
  W: 5,
  A: 6,
  S: 7,
  D: 8,
  J: 9,
  K: 10,
  L: 11,
  Escape: 12,
  Enter: 13,
  B: 14,
  C: 15,
  E: 16,
  F: 17,
  G: 18,
  H: 19,
  I: 20,
  M: 21,
  N: 22,
  O: 23,
  P: 24,
  Q: 25,
  R: 26,
  T: 27,
  U: 28,
  V: 29,
  X: 30,
  Y: 31,
  Z: 32,
  Digit0: 33,
  Digit1: 34,
  Digit2: 35,
  Digit3: 36,
  Digit4: 37,
  Digit5: 38,
  Digit6: 39,
  Digit7: 40,
  Digit8: 41,
  Digit9: 42,
  Tab: 43,
  Backspace: 44,
  Minus: 45,
  Equal: 46,
  BracketLeft: 47,
  BracketRight: 48,
  Backslash: 49,
  Semicolon: 50,
  Quote: 51,
  Backquote: 52,
  Comma: 53,
  Period: 54,
  Slash: 55,
  ShiftLeft: 56,
  ShiftRight: 57,
  ControlLeft: 58,
  ControlRight: 59,
  AltLeft: 60,
  AltRight: 61,
  F1: 62,
  F2: 63,
  F3: 64,
  F4: 65,
  F5: 66,
  F6: 67,
  F7: 68,
  F8: 69,
  F9: 70,
  F10: 71,
  F11: 72,
  F12: 73,
};

// KeyboardEvent.code for each Key id.
export const keyCodes: string[] = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyJ",
  "KeyK",
  "KeyL",
  "Escape",
  "Enter",
  "KeyB",
  "KeyC",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Tab",
  "Backspace",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
];

// SDL scancode for each Key id.
export const keyScancodes: number[] = [
  80, 79, 82, 81, 44, 26, 4, 22, 7, 13, 14, 15, 41, 40, 5, 6, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 23, 24, 25, 27, 28, 29, 39, 30, 31, 32, 33, 34, 35, 36, 37, 38, 43, 42, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 225, 229, 224, 228, 226, 230, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
];

export const GamepadAxis = { LeftX: 0, LeftY: 1, RightX: 2, RightY: 3 };
// Button ids follow the W3C "standard" gamepad layout on every backend.
export const GamepadButton = {
  South: 0,
  East: 1,
  West: 2,
  North: 3,
  LeftShoulder: 4,
  RightShoulder: 5,
  LeftTrigger: 6,
  RightTrigger: 7,
  Back: 8,
  Start: 9,
  LeftStick: 10,
  RightStick: 11,
  DpadUp: 12,
  DpadDown: 13,
  DpadLeft: 14,
  DpadRight: 15,
  Guide: 16,
};
// SDL_GamepadButton for each standard id; -1 marks the triggers, which SDL reports as axes 4 and 5.
export const sdlGamepadButtons: number[] = [0, 1, 2, 3, 9, 10, -1, -1, 4, 6, 7, 8, 11, 12, 13, 14, 5];
export const MouseButton = { Left: 1, Middle: 2, Right: 4 };

export interface Pointer {
  // Normalized to the window content: [0, 1] inside, past those bounds outside it.
  x: number;
  y: number;
  // Bitmask of MouseButton values.
  buttons: number;
}

export interface Touch {
  // Stable while the finger stays down.
  id: number;
  // Normalized to the window content, [0, 1] on each axis.
  x: number;
  y: number;
}

export interface Input {
  down: (key: number) => boolean;
  // First held key, or -1; used to rebind controls.
  firstDown: () => number;
  // Gamepad slot pad (0 is player 1); 0 or false when the slot is empty.
  axis: (pad: number, axis: number) => number;
  button: (pad: number, button: number) => boolean;
  pointer: () => Pointer;
  // Fingers currently down, in no particular order.
  touches: () => Touch[];
  // Mouse movement in CSS pixels since the last call, for first-person look. On the web it needs pointer lock
  // (run(..., { pointerLock: true }) locks on click). Native backends report 0 until SDL relative mode is wired.
  look: () => Look;
}

export interface Look {
  x: number;
  y: number;
}
