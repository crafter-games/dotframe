// Which keys read as down on the web. A key pressed and released before the game reads it still reads as down once:
// fresh holds the keys pressed and not read yet, and a release of one of them waits in late until a read. A frame
// that runs no fixed step reads nothing, so the tap carries over to the next frame instead of being lost.
export interface KeyLatch {
  press: (code: string) => void;
  release: (code: string) => void;
  // Reading a down key counts as the read a pending release waits for.
  down: (code: string) => boolean;
  // Called after each frame: drops the releases whose key has been read.
  endFrame: () => void;
  clear: () => void;
}

export function createKeyLatch(): KeyLatch {
  const pressed = new Set<string>();
  const fresh = new Set<string>();
  const late = new Set<string>();
  return {
    press: (code: string): void => {
      pressed.add(code);
      fresh.add(code);
      late.delete(code);
    },
    release: (code: string): void => {
      if (fresh.has(code)) late.add(code);
      else pressed.delete(code);
    },
    down: (code: string): boolean => {
      if (!pressed.has(code)) return false;
      fresh.delete(code);
      return true;
    },
    endFrame: (): void => {
      for (const code of late)
        if (!fresh.has(code)) {
          pressed.delete(code);
          late.delete(code);
        }
    },
    clear: (): void => {
      pressed.clear();
      fresh.clear();
      late.clear();
    },
  };
}

// A press the game takes (and cancels in the browser): one of its keys with no Cmd, Ctrl or Alt held. Modified
// presses are the browser's own shortcuts (Cmd+Ctrl+F leaves full screen, Cmd+R reloads) and must reach it.
export function isGameKey(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, codes: readonly string[]): boolean {
  return codes.includes(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey;
}
