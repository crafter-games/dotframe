// Native entry for dotframe build macos|windows. The CLI stages it with the engine and compiles it with scriptc.
import { run } from "dotframe/src/native/run";
import { WINDOW } from "./src/game";
import { createSetup } from "./src/setup";

await run(WINDOW, createSetup());
