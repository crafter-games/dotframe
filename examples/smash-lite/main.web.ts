import { run } from "../../src/web/run";
import { createSetup, windowOptions } from "./game";

await run(windowOptions, createSetup(new URLSearchParams(location.search).has("demo")));
