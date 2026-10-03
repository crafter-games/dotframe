import { loadBytes, run } from "../../src/web/run";
import { assetPath, createSetup, windowOptions } from "./game";

await run(windowOptions, createSetup(await loadBytes(assetPath)));
