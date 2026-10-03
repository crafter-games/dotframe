import { run } from "../../src/native/run";
import { createSetup, windowOptions } from "./game";

await run(windowOptions, createSetup(process.env.DF_DEMO === "1"));
