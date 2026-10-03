import type { Audio } from "./audio";
import type { Gpu } from "./gpu";
import type { Input } from "./input";
import type { Storage } from "./storage";

// Everything a game gets from the backend it runs on.
export interface Platform {
  gpu: Gpu;
  input: Input;
  audio: Audio;
  storage: Storage;
}
