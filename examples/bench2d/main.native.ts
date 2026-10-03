import { loadBytes, run } from "../../src/native/run";
import { createSetup, type StageResult, windowOptions } from "./game";

const root = process.env.DF_ROOT ?? ".";
const start = performance.now();
await run(
  windowOptions,
  createSetup(
    {
      sprite: await loadBytes(`${root}/assets/crafter.png`),
      fontAtlas: await loadBytes(`${root}/assets/fonts/bangers.png`),
      fontMetrics: await loadBytes(`${root}/assets/fonts/bangers.json`),
    },
    (result: StageResult): void => console.log(JSON.stringify(result)),
    (): number => performance.now(),
    // Process start to the first frame with assets ready.
    (): void => console.log(JSON.stringify({ firstFrameMs: performance.now() - start })),
  ),
);
