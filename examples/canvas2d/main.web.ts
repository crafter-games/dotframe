import { loadBytes, run } from "../../src/web/run";
import { assetPaths, createSetup, windowOptions } from "./game";

await run(
  windowOptions,
  createSetup({
    sprite: await loadBytes(assetPaths.sprite),
    bangersAtlas: await loadBytes(assetPaths.bangersAtlas),
    bangersMetrics: await loadBytes(assetPaths.bangersMetrics),
    archivoAtlas: await loadBytes(assetPaths.archivoAtlas),
    archivoMetrics: await loadBytes(assetPaths.archivoMetrics),
  }),
);
