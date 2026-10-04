import { run } from "dotframe/src/web/run";
import { WINDOW } from "./src/game";
import { createSetup } from "./src/setup";

await run(WINDOW, createSetup());
