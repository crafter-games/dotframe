// Backend-agnostic audio: decoded sound effects, square tones and one streamed music track.

export interface Audio {
  loadSound: (mp3: Uint8Array) => Promise<number>;
  // rate scales pitch and speed together, like AudioBufferSourceNode.playbackRate.
  play: (sound: number, volume: number, rate: number) => void;
  // Square wave decaying exponentially to silence over duration seconds.
  tone: (frequency: number, duration: number, volume: number) => void;
  loadMusic: (mp3: Uint8Array) => Promise<number>;
  playMusic: (track: number, loop: boolean, volume: number) => void;
  stopMusic: () => void;
  pauseMusic: (paused: boolean) => void;
  setMusicVolume: (volume: number) => void;
  setMasterVolume: (volume: number) => void;
}
