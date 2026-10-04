# Error codes

| Code | Meaning | Fix |
|---|---|---|
| NO_CONFIG | No dotframe.json here or above | cd into the game, or `dotframe new` |
| BAD_CONFIG | dotframe.json does not parse | Fix the JSON |
| NO_SIM / SIM_MISSING / BAD_SIM | The sim module is not set, missing, or not `defineSim` | See the Sim contract in core |
| INPUTS_MISSING / BAD_INPUTS | Inputs file missing or a line has the wrong shape | One JSON array or `{frame, inputs}` per line, one input per player |
| BAD_OPTIONS | `--options` is not a JSON object | Quote it: `--options '{"stocks": 1}'` |
| UNKNOWN_TARGET | Target not in dotframe.json | Use a listed target or add one |
| STEP_FAILED | A build step exited non-zero | Read the file in `log` (full output); `dotframe doctor` |
| ASSETS_LOCAL_ONLY | A release would ship unlicensed assets | See `assets` |
| APPROVAL_REQUIRED (exit 2) | External action without `--yes` | Show the `--dry-run` plan to the human |
| DEPLOY_SOURCE_DIR | Deploy dir looks like source (repo root, .git, dotframe.json) | Point `out` at the build folder |
| NOT_BUILT | Artifact missing | `dotframe build <target>` |
| CONFIG_PLACEHOLDER | Template value never filled in | `dotframe config set ...` |
| DEPLOY_FAILED / INSTALL_FAILED | Provider command failed | Message carries the provider output |
| TOOL_MISSING | A required CLI is not installed | `dotframe doctor` lists the install command |
| SNAP_TIMEOUT / SNAP_PAGE_ERROR / BROWSER_FAILED | The snap page did not report ready | Usually no WebGPU in the browser; see message |
| BAD_ARG / MISSING_ARG | A flag value is not a valid number or duration, or a required flag is missing | Use the value in `fix` |
| VENDOR_MISSING | Native build without SDL3 or wgpu-native | `dotframe vendor <platform>` |
| ENTRY_MISSING | The native entry module does not exist | Add `main.native.ts` or fix `native.entry` |
| SNAP_SIZE | The screenshot size does not match the game window | Close other agent-browser sessions and retry |
| UNSUPPORTED | The command does not apply (e.g. desync on a 1-player sim) | |
| REPLAY_MISSING | Replay file not found | `dotframe replay record` |
| UNKNOWN_SKILL / UNKNOWN_TEMPLATE / UNKNOWN_COMMAND | Typo | Read the `fix` list |
