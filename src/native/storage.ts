// The native Storage: one JSON object in SDL's per-user preferences directory (<prefs>/dotframe/<app>/storage.json),
// rewritten on every set. On iOS that is the app's own Library, so a save survives quitting the app.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Storage } from "../storage";
import { dfPrefPath } from "./ffi";

// Stores values as one JSON object in <prefs>/dotframe/<app>/storage.json, rewritten on every set.
export function openStorage(app: string): Storage {
  const pathBytes = new Uint8Array(1024);
  const length = dfPrefPath("dotframe", app.split(":").join("").split("/").join("-"), pathBytes);
  const file = length > 0 ? `${new TextDecoder().decode(pathBytes.subarray(0, length))}storage.json` : "";
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

