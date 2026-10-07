---
name: ios
description: Build and install the iOS target of a dotframe game. Use when building for iPhone or iPad, writing the iOS entry, setting the bundle id, team, icon or orientation, installing on a device, or debugging touch input on iOS.
---
# ios

```sh
dotframe vendor ios                  # once per machine: SDL3 (Xcode generator) and wgpu-native for iOS
# or reuse an existing vendor (a dotframe checkout's vendor/): export DOTFRAME_VENDOR=<path>
dotframe doctor                      # vendor:ios, ios-runtime (scriptc pack matching the compiler), team placeholder
dotframe build ios --json            # dist/ios/<Scheme>.app
dotframe device install ios --dry-run
dotframe device install ios --yes    # after the human approves; phone unlocked and trusted
```

## The target

```json
"ios": { "native": { "platform": "ios", "entry": "main.ios.ts", "bundleId": "run.crafter.mygame", "team": "ABCDE12345",
                     "icon": "assets/icon.png", "orientation": "landscape", "assets": "assets", "displayName": "My Game" },
         "device": "<udid from xcrun devicectl list devices>" }
```

The CLI stages the entry's import graph (like macOS), generates the library glue and profile, builds the scriptc library, generates the SDL3 host (`main.c`), `Info.plist` and `project.yml`, scales `icon` to 1024 px (iOS derives every other size; without `icon` the app has none), copies `assets` to `<app>/game/<assets>` and the engine fonts to `<app>/game/dotframe/assets/fonts`, and runs xcodegen and xcodebuild. The launch screen is `launchColor` (`"#rrggbb"`, default black) with an optional centered `launch` PNG; it stays up while `init` loads, since native loading is synchronous. Everything generated lives in `.dotframe/native/ios/`; nothing to commit.

## The entry

scriptc library mode: the host calls `init(base)` once with the bundle's game folder and `frame(time)` every refresh. There are no promises, so load assets synchronously with the library platform's `readFile`, `image` and `sound`.

```ts
import type { Frame } from "dotframe/src/gpu";
import { openLibraryPlatform } from "dotframe/src/native/library";

let tick: Frame | null = null;
export function init(base: string): void {
  const platform = openLibraryPlatform(WINDOW);
  const png = platform.readFile(`${base}/assets/hero.png`);
  tick = createSetup(/* ... */)(platform);
}
export function frame(time: number): boolean {
  return tick ? tick(time) : true;
}
```

Templates ship this as `main.ios.ts` over the same `src/setup.ts` web and macOS use. A game with async loaders adds a sync variant that takes a `(path) => Uint8Array` reader, or writes one loader against that reader for every target.

## Notes

- Crash with no message? `dotframe device logs ios` copies the newest crash report from the device and prints the exception and crashed thread. build ios also wraps init and frame so a TypeScript throw prints `dotframe: init threw: <message and stack>` to the device log before scriptc's trap aborts.
- scriptc library mode caps host callbacks at 32. build ios registers only the df* functions the entry reaches (a game without networking uses 27, with the native relay 29); the glue fails with the list if a game goes over.
- Textures: native has no fixed cap anymore; free what you replace with `gpu.destroyTexture(texture)` (its id is retired, do not draw it again).
- Online on iOS: `connectRelayNative` and `shareText` from `dotframe/src/native/relay` (see netplay).

- The scriptc runtime pack (`@scriptc/runtime-ios-arm64`) must match `scriptc --version`. Right after a scriptc release, bun's minimum release age blocks it; doctor prints the install command with `--minimum-release-age 0`.
- Touches never synthesize a mouse (SDL_HINT_TOUCH_MOUSE_EVENTS is off), so read `input.touches()` for fingers; `input.pointer()` stays the mouse.
- Size the logical canvas from `gpu.aspect()` (templates do): a 1280x720 canvas on a 2.16 phone stretches otherwise.
- Library mode has no browser `WebSocket`: use `dotframe/src/native/relay`, not `dotframe/src/relay-client`.
- Signing is automatic with `team`; a locked password manager can fail signing with `failed to fill whole buffer`: ask the human to unlock it and retry.
- `build ios --release` refuses assets marked local-only (see `assets`).
- Confirm on the device by asking the human. A successful install is not a working game.
- Xcode, not Command Line Tools: xcodebuild and devicectl need Xcode. When `xcode-select -p` points at CommandLineTools and `/Applications/Xcode.app` exists, `build`, `device` and `doctor` set `DEVELOPER_DIR` to Xcode for their own run; other shells need `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` (or `sudo xcode-select -s` once). doctor runs `xcodebuild -version` and fails when it does.
- Free (personal) teams: provisioning lasts 7 days, so reinstall weekly, and a device holds at most 3 apps signed by a free team; the 4th install fails until one is deleted from the phone. A paid team whose Account Holder has not accepted the latest Program License Agreement on developer.apple.com fails in xcodebuild; only the Account Holder can accept it.
- The console of a throw (`init threw: ...`) shows with `xcrun devicectl device process launch --console --terminate-existing --device <id> <bundleId>`.
