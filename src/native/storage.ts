// The native Storage: one JSON object in SDL's per-user preferences directory (<prefs>/dotframe/<app>/storage.json),
// rewritten on every set. On iOS that is the app's own Library, so a save survives quitting the app.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Storage } from "../storage";
import { dfPrefPathByte } from "./ffi";

// Stores values as one JSON object in <prefs>/dotframe/<app>/storage.json, rewritten on every set.
export function openStorage(app: string): Storage {
  // Read a byte at a time: iOS library mode's callbacks cannot fill a buffer.
  const name = app.split(":").join("").split("/").join("-");
  const bytes: number[] = [];
  for (let b = dfPrefPathByte("dotframe", name, 0); b >= 0 && bytes.length < 1024; b = dfPrefPathByte("dotframe", name, bytes.length)) bytes.push(b);
  const file = bytes.length > 0 ? `${new TextDecoder().decode(new Uint8Array(bytes))}storage.json` : "";
  const values = new Map<string, string>();
  if (file !== "" && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const key of Object.keys(saved)) values.set(key, saved[key]);
  }
  return {
    get: (key: string): string | null => values.get(key) ?? null,
    set: (key: string, value: string): void => {
      values.set(key, value);
      if (file === "") return;
      const out: Record<string, string> = {};
      for (const [k, v] of values) out[k] = v;
      writeFileSync(file, JSON.stringify(out));
    },
  };
}

