import { dcos, dsin } from "./detmath";

// Backend-agnostic audio: decoded sound effects, square tones and up to MUSIC_CHANNELS streamed music tracks at once.

// Music channels: tracks that stream together, each with its own volume (a layered score crossfades between them).
export const MUSIC_CHANNELS = 4;

// Synchronous playback controls, usable in scriptc library mode (iOS) where promises are unavailable.
export interface AudioPlayer {
  // rate scales pitch and speed together, like AudioBufferSourceNode.playbackRate.
  play: (sound: number, volume: number, rate: number) => void;
  // Square wave decaying exponentially to silence over duration seconds.
  tone: (frequency: number, duration: number, volume: number) => void;
  // channel: 0 to MUSIC_CHANNELS - 1 (0 when left out).
  playMusic: (track: number, loop: boolean, volume: number, channel?: number) => void;
  stopMusic: (channel?: number) => void;
  pauseMusic: (paused: boolean, channel?: number) => void;
  setMusicVolume: (volume: number, channel?: number) => void;
  setMasterVolume: (volume: number) => void;
  // A voice you can steer: returns its id (0 when it cannot play). Looping voices run until stopVoice.
  start: (sound: number, volume: number, rate: number, loop: boolean) => number;
  // pan is -1 (left) to 1 (right). Calls on a finished or stopped voice do nothing.
  setVoice: (voice: number, volume: number, pan: number) => void;
  stopVoice: (voice: number) => void;
}

export interface Spatial {
  volume: number;
  pan: number;
}

// Volume and pan of a source heard by a listener at (x, z) facing yaw (radians; forward is (-sin, -cos), as in
// first-person cameras built on lookAt). Falls off to silence at range, quadratic like the 3D renderer's lights.
export function spatial(listenerX: number, listenerZ: number, yaw: number, sourceX: number, sourceZ: number, range: number): Spatial {
  const dx = sourceX - listenerX;
  const dz = sourceZ - listenerZ;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const t = Math.max(0, 1 - distance / Math.max(range, 1e-6));
  if (distance < 1e-6) return { volume: t * t, pan: 0 };
  // The listener's right is (cos, -sin); the pan is the source direction's projection on it.
  // detmath, so a sim whose render calls this still passes doctor's sim:math check.
  const pan = ((dx * dcos(yaw) - dz * dsin(yaw)) / distance) * 0.8;
  return { volume: t * t, pan };
}

export interface Audio extends AudioPlayer {
  loadSound: (mp3: Uint8Array) => Promise<number>;
  loadMusic: (mp3: Uint8Array) => Promise<number>;
}
