---
name: assets
description: Asset licensing and loading for dotframe games. Use when adding sprites, audio, or fonts, or before any release or store build.
---
# assets

- Mark every asset you cannot distribute in `assets.localOnly` in dotframe.json (paths relative to the repo). `dotframe build <target> --release` fails with `ASSETS_LOCAL_ONLY` while any of them exists. Debug builds and local play are unaffected.
- To ship, replace the files with licensed ones (original art, CC0, or licensed packs), record the source and license next to them, then remove the path from `localOnly`.
- Fonts render through SDF atlases baked by `tools/bake-font.c`. Keep the font license (for example SIL OFL) with the atlas.
- Headless runs (`sim`, `replay`, `desync`) skip asset loading. If gameplay depends on asset data (sprite boxes, frame counts), load that data in headless too, or the sim will differ from the real game.
- `snap` loads assets from the game root over HTTP, so asset paths must be relative to the repo root.
