import { loadBytes, run } from "../../src/native/run";
import { assetPaths, createSetup, windowOptions } from "./game";

const root = process.env.DF_ROOT ?? ".";
await run(
  windowOptions,
  createSetup({
    sprite: await loadBytes(`${root}/${assetPaths.sprite}`),
    bangersAtlas: await loadBytes(`${root}/${assetPaths.bangersAtlas}`),
    bangersMetrics: await loadBytes(`${root}/${assetPaths.bangersMetrics}`),
    archivoAtlas: await loadBytes(`${root}/${assetPaths.archivoAtlas}`),
    archivoMetrics: await loadBytes(`${root}/${assetPaths.archivoMetrics}`),
  }),
);
