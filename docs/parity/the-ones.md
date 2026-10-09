# Godot parity: The Ones

What The Ones (Godot 4, first-person horror, `crafter-games/the-ones`) actually uses, against what dotframe has. Built from the Godot scripts (`grep` of `.new()` constructors and properties in `scripts/`, 29 shaders in `shaders/`) and from porting chapters 2 and 3 (`the-ones-dotframe`, `CHAPTER2.md`, `CHAPTER3.md`). Counts are uses in the Godot scripts, a rough measure of weight.

This is a work list for an agent. Parity here means "the port can show what the Godot build shows", not "dotframe clones Godot". A feature nobody's game uses does not belong here.

## Rules for whoever takes a task

- Engine work goes in `crafter-games/dotframe` on a branch off `main`, one PR per task or per small group. Never push to `main`.
- Each task: a unit test in `test/` that fails before and passes after, `bun test`, the three `tsc` projects (`tsconfig.json`, `cli/tsconfig.json`, `src/native/tsconfig.json`), and a CHANGELOG line under Unreleased.
- Visual tasks: prove it in a real game with `dotframe snap` (before and after PNGs) and look at them. "The code looks right" is not done.
- Native: the feature must compile and run with scriptc. Run `dotframe replay verify replays/*.json --native` in `the-ones-dotframe` after linking the branch.
- Mobile is automatic (owner decision): any per-frame GPU cost gets its phone path inside the engine, chosen by platform (`gpu.mobile`, iOS host, coarse pointer), like instance thinning (`INSTANCE_DETAIL`). No game flag, no manual step. Say in the PR what the phone does.
- Update the status column here in the same PR.

## Matrix

Status: **has** (dotframe does it), **sub** (the port fakes it acceptably), **partial** (some of it), **missing**.

| Godot feature | Uses | Status | Evidence and gap | Task |
|---|---|---|---|---|
| MeshInstance3D, StandardMaterial3D (albedo, texture, emission, alpha cut) | 99, 38 | has | `MeshRef` color, texture, triplanar, emissive, alphaCutoff | - |
| Roughness, metallic, clearcoat, specular | many | missing | One fixed lighting model. The deer's eyes and wet skin read flat | T9 |
| ShaderMaterial (29 custom shaders: skin, foliage, water, shoji, CRT, dog coat...) | 37 | partial | `Renderer.createMaterial` + `MeshRef.material`/`params`: fragment surface code (albedo, emission) under the built-in lighting. `one_skin` is ported. No vertex hook yet (`one_skin`'s glitch, foliage wind beyond `sway`), and specular, roughness, rim and SSS wait on T9 | T1 |
| BoxMesh, CylinderMesh, SphereMesh, QuadMesh, PlaneMesh, TorusMesh, PrismMesh, CapsuleMesh | 27, 33, 18, 17, 12, 7, 3, 1 | partial | Engine ships only `box()`. The port writes cylinder, sphere, dome, quad, floor quad and torus itself in `src/scene.ts` | T2 |
| OmniLight3D | 27 | partial | `PointLight`, at most 8 (`MAX_LIGHTS`), no shadow maps; `PointLight.box` keeps light inside walls as a stand-in | T4 |
| SpotLight3D | 13 | has | `Environment.spots`, up to `MAX_SPOTS` (4) with `spot`; one shadow map, given to the first spot that asks. Flashlight and camcorder IR light together. A second shadowed spot is not supported | T3 |
| DirectionalLight3D with shadows | 10 | has | `Environment.sun` with a camera-following ortho shadow map | - |
| Shadows from point lights, skinned and instanced meshes | 28 `shadow_enabled` | missing | Only static meshes cast, only from the sun and the spot | T4 |
| Volumetric fog, FogVolume, light_volumetric_fog_energy | 23, 2, 21 | sub | `fog.scatter` (closed-form in-scattering from point lights, `PointLight.fog`) and `fog.volumes` (boxes with height falloff). The sect tape's mist glows around its back light and lanterns. Not covered: spot and sun scattering, anisotropy, edge fade, fog over the sky (only surfaces get it) | T5 |
| Glow / bloom | 4 | missing | Lamps, lanterns and the vending machine have no halo (postfx halation is a partial stand-in) | T6 |
| Depth of field (`dof_blur`) | 6 | missing | The tape's hunting autofocus and the news clips' defocus | T6 |
| SSAO, SSR | 2, 1 | missing | Low priority | - |
| SubViewport (render to texture, own world) | 12 (48 refs) | has | `gpu.createTarget`, `Draw2D` into a target, a second `World` on the same renderer (fixed in `cfc6891`), `Camera.aspect`, `Camera.fixed` | - |
| Camera cull mask, VisualInstance layers | 10, 5 | has | `MeshRef.layers`, `Camera.layers` | - |
| Camera roll | - | has | `Camera.roll` | - |
| MultiMesh | 8 | has | `addInstances`, ground cells, culling, mobile thinning, `updateInstances` | - |
| Skinned meshes, AnimationPlayer (play, seek, speed, pause) | 3 + per actor | has | `addSkinnedMesh`, `sampleAnimation`; seek and speed are arithmetic in the game | - |
| BoneAttachment3D | 9 | missing | The port converts bone positions to world by hand three times (Tetsuo's cigarette, the visitor's lantern, the tape's ropes) | T7 |
| AnimationTree, blend spaces | 0 | - | Not used | - |
| Retargeting across rigs | - | has | `src/retarget.ts` | - |
| Decal | 3 | sub | Toe prints are flat quads on a flat dike. A decal on terrain or a wall would need projection | T10 |
| Label3D | 7 | missing | Signs and labels in the world | T11 |
| Sprite3D billboard, alpha cut | 2, 10 | partial | The forest uses instanced impostor quads; no billboard flag on `MeshRef` | T11 |
| GPUParticles3D, CPUParticles3D | 6 | partial | `emitParticles` draws camera-facing soft discs; no textures, no velocity fields | T12 |
| CSG shapes | 14 | sub | Boxes in the port; enough | - |
| GradientTexture2D, NoiseTexture2D | 10, 5 | sub | The port fills `gpu.createTexture` RGBA itself (toe prints); a helper would save code | T13 |
| Screen-texture mip levels in shaders (`textureLod`) | postfx, VHS | missing | Targets have no mips; three ported shaders fake blur with taps (F-003d) | T8 |
| ProceduralSkyMaterial | 2 | has | `Environment.sky` | - |
| AudioStreamPlayer3D | 21 | partial | `spatial()` gives volume and pan on the ground plane; no elevation (Kuro barking from the roof), no distance model options | T14 |
| pitch_scale | 23 | has | play rate | - |
| Audio buses and effects | 20 | sub | Effects (radio, tape, phone) are baked into the voice files in Godot too | - |
| Tween | 40 | missing | Every fade, dolly and blink is hand-written per frame in the game, and timing math is easy to get wrong | T15 |
| `is_position_in_frustum` | 1 | missing | `inView` exists inside `render.ts` but is not exported; the news clip's sting needs "is the figure on screen" | T16 |
| StaticBody3D, CollisionShape3D (box, cylinder, capsule) | 9, 12 | partial | `physics.ts` steps a body against boxes; the port builds colliders from its own boxes | - |
| Fonts with every glyph the text uses | - | has | `assets font --chars-from` (Latin Extended fixed in PR #14) | - |
| Hints / UI widgets | - | missing (game) | The port has no hint system yet; game-side, not engine | - |

## Tasks

Ordered by what chapter 3's remaining slices (8 to 13) and the next ports need first.

### T1 Custom material shaders
Let a `MeshRef` carry fragment WGSL (like `createPostPass` does for full-screen passes) with the lighting inputs available, so a game can port `one_skin`, `vegetation`, `shoji`, `crt`. Keep shadow and fog behavior identical to built-in materials. Acceptance: The Ones' deer with a ported `one_skin` reads pale grey in a snap, and an unmodified scene renders byte-identical draws. Mobile: same shader, no extra pass.

### T2 Primitive shapes in the engine
Move `cylinder`, `sphere` (and hemisphere), `quad`, `floorQuad`, `torus`, `plane`, `capsule`, `prism` into `src/shapes.ts` with Godot's sizes as defaults (unit size, scale is the size). Then delete the copies in `the-ones-dotframe/src/scene.ts`. Acceptance: tests for vertex counts and normals; The Ones' 22 replays still pass (presentation only).

### T3 Several spot lights
`Environment.spots: SpotLight[]` (keep `spot` working), shadows on at most one or two, chosen by the engine. Acceptance: flashlight and camcorder IR lit together in a snap. Mobile: the engine drops spot shadows past the first on phones.

### T4 Point light shadows and more casters
Cube or dual-paraboloid shadow maps for a few point lights, and skinned meshes as casters. Acceptance: the house lamp no longer needs `PointLight.box` to stop at the walls (snap behind the house at 21:00, compare with the box version). Mobile: fewer or smaller maps, chosen by the engine.

### T5 Volumetric fog stand-in
A cheap screen-space height fog with in-scattering toward lights (not a froxel grid), plus fog volumes as boxes. Acceptance: the sect tape's mist glows around the back light in `preview: "tape"`. Mobile: lower sample count automatically.

### T6 Glow and depth of field as post passes
Engine-provided bloom (threshold, intensity) and DOF (focus distance, blur), composable with a game's post pass. Acceptance: lanterns get halos in a night snap; the tape's zoom shot blurs the foreground. Mobile: half-resolution passes.

### T7 Bone attachment helper
`attachPoint(model, rig or pose, placement, bone, offset) -> Vec3` and its rotation, replacing the hand-written `toWorld` in the port. Acceptance: the cigarette, lantern and ropes in The Ones use it with unchanged snaps.

### T8 Mips on render targets
`createTarget(w, h, { mips: true })` with a generate step, so post shaders can sample blurred levels. Acceptance: postfx and the two VHS shaders use `textureSampleLevel` at Godot's levels; the tap fallbacks go.

### T9 PBR-lite parameters
Roughness and metallic on `MeshRef` with a simple specular term. Acceptance: wet skin and the vending machine's front read differently from matte plaster.

### T10 Projected decals
Box-projected decals onto whatever is under them. Acceptance: the toe prints on uneven ground.

### T11 Billboards and world text
`MeshRef.billboard` (fixed-Y and full) and world-space SDF text from the existing font atlases.

### T12 Particles with textures and motion
Textured particles, velocity, gravity, spawn shapes.

### T13 Generated textures
`gradientTexture`, `noiseTexture` helpers on `gpu.createTexture`.

### T14 3D audio
Elevation, distance models, an optional listener up vector. Acceptance: a bark from (−4, 5, −15) sounds above, not beside.

### T15 Deterministic tweens
Frame-based tweens (property, from, to, duration, easing) evaluated from frames since start, so presentation code stops hand-integrating fades. Must stay out of simulation state or be snapshot-safe.

### T16 Frustum query
Export `inView` or add `Renderer.onScreen(camera, point)`.

## Extending this to the next game

1. `grep -rhoE "\b[A-Z][A-Za-z0-9]*(3D|Mesh|Material|Light|Environment|...)\.new\(\)" scripts | sort | uniq -c` on the Godot source, plus a grep of the properties above.
2. Add a column per game instead of a new file, so a gap two games share rises to the top.
3. A gap that appears in two games goes to the engine before a third port asks for it.
