// Backend-agnostic audio: decoded sound effects, square tones and one streamed music track.

// Synchronous playback controls, usable in scriptc library mode (iOS) where promises are unavailable.
export interface AudioPlayer {
  // rate scales pitch and speed together, like AudioBufferSourceNode.playbackRate.
  play: (sound: number, volume: number, rate: number) => void;
  // Square wave decaying exponentially to silence over duration seconds.
  tone: (frequency: number, duration: number, volume: number) => void;
  playMusic: (track: number, loop: boolean, volume: number) => void;
  stopMusic: () => void;
  pauseMusic: (paused: boolean) => void;
  setMusicVolume: (volume: number) => void;
  setMasterVolume: (volume: number) => void;
}

export interface Audio extends AudioPlayer {
  loadSound: (mp3: Uint8Array) => Promise<number>;
  loadMusic: (mp3: Uint8Array) => Promise<number>;
}
