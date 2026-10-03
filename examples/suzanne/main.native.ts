import { loadBytes, run } from "../../src/native/run";
import { assetPath, createSetup, windowOptions } from "./game";

const root = process.env.DF_ROOT ?? ".";
await run(windowOptions, createSetup(await loadBytes(`${root}/${assetPath}`)));
