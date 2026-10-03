import { loadBytes, run } from "../../src/web/run";
import { createSetup, type StageResult, windowOptions } from "./game";

const results: StageResult[] = [];
(globalThis as unknown as { benchResults: StageResult[] }).benchResults = results;
await run(
  windowOptions,
  createSetup(
    {
      sprite: await loadBytes("assets/crafter.png"),
      fontAtlas: await loadBytes("assets/fonts/bangers.png"),
      fontMetrics: await loadBytes("assets/fonts/bangers.json"),
    },
    (result: StageResult): void => {
      results.push(result);
      console.log(JSON.stringify(result));
    },
    (): number => performance.now(),
    // Navigation start to the first frame with assets ready.
    (): void => {
      (globalThis as unknown as { firstFrameMs: number }).firstFrameMs = performance.now();
    },
  ),
);
