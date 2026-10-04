---
name: ios
description: Build and install the iOS target of a dotframe game. Use when building for iPhone, fixing vendor links, signing, or installing on a device.
---
# ios

```sh
dotframe doctor --json               # vendor links, scriptc, xcodegen, xcodebuild
dotframe doctor --fix                # creates missing vendor symlinks
dotframe build ios --json            # glue, scriptc library, xcodegen, xcodebuild
dotframe device install ios --dry-run
dotframe device install ios --yes    # after approval; phone unlocked and trusted
```

- The iOS build needs SDL3 and wgpu-native iOS builds under `vendor/dotframe/vendor/`. They are local symlinks (`links` in dotframe.json), not in git. `doctor --fix` creates them when the targets exist.
- Signing uses the team in the Xcode project; `-allowProvisioningUpdates` lets xcodebuild fetch profiles. A locked password manager can fail signing with `failed to fill whole buffer`: ask the human to unlock it and retry.
- `targets.ios.app` is the built `.app`; `targets.ios.device` comes from `xcrun devicectl list devices`.
- `build ios --release` refuses assets marked local-only (see `assets`). Debug builds for your own phone are fine.
- Confirm on the device by asking the human, or with a screenshot if available. A successful install is not a working game.
