// iOS entry for dotframe build ios: scriptc library mode, so the generated host calls init once with the bundle's
// game folder (assets under <base>/assets, engine fonts under <base>/dotframe/assets/fonts) and frame every refresh.
// Library mode has no promises: load assets synchronously with platform.readFile.
import type { Frame } from "dotframe/src/gpu";
import { openLibraryPlatform } from "dotframe/src/native/library";
import { WINDOW } from "./src/game";
import { createSetup } from "./src/setup";

let tick: Frame | null = null;

export function init(_base: string): void {
  const platform = openLibraryPlatform(WINDOW);
  tick = createSetup({ link: null, mash: null })(platform);
}

// Returns false to ask the host to quit.
export function frame(time: number): boolean {
  return tick ? tick(time) : true;
}
