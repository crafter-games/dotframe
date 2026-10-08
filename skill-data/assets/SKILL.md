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
- The engine loads PNG, not SVG. Rasterize SVGs at build time (for example with sharp in a build step) at the largest size the game draws them, and commit or generate the PNGs.
- Ship size: the web template's `build-web.ts` and iOS builds copy assets through `slimAssets` (`dotframe assets slim <src> <out>` by hand). Each GLB keeps only what `loadGlb` reads, so normal, roughness and occlusion maps, tangents and second UV sets are dropped; 32-bit indices become 16-bit when they fit; opaque PNG base colors become JPEG through ffmpeg (list ffmpeg in `requires`). Sources stay untouched. `snap` serves the sources, so check JPEG artifacts in a built game.
- Importing a model from another project: `dotframe assets slim <src.glb> <out.glb> --clips a,b --rename a=walk,b=bark` keeps only the clips the game plays, named as the game plays them. Exporters pack all clips into a few buffer views; slim copies only the kept accessors' bytes, so dropping clips shrinks the file.
- Fonts: `dotframe assets font <font.ttf> assets/fonts/<name> --chars-from src` bakes the SDF atlas Draw2D.addFont reads, with every character beyond Latin-1 that the game's text uses (kanji, dashes, quotes). Re-run it after adding captions. It builds tools/bake-font.c with the machine's C compiler once. Keep the font license next to the atlas.
