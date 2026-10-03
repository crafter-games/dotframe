// Engine-level input ids. Backends map them to SDL scancodes (native) or KeyboardEvent.code (web).

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
};

export const GamepadAxis = { LeftX: 0, LeftY: 1 };
export const GamepadButton = { South: 0, East: 1, West: 2, North: 3 };

export interface Input {
  down: (key: number) => boolean;
  // First connected gamepad; 0 or false without one.
  axis: (axis: number) => number;
  button: (button: number) => boolean;
}
