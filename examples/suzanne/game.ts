import type { Audio } from "../../src/audio";
import { createWorld, spawn } from "../../src/ecs";
import { parseGlb } from "../../src/gltf";
import type { Frame, Gpu, Setup } from "../../src/gpu";
import type { Input } from "../../src/input";
import { vec3 } from "../../src/math";
import { createRenderer } from "../../src/render";

export const windowOptions = { width: 960, height: 540, title: "dotframe: suzanne" };
export const assetPath = "assets/suzanne.glb";

export function createSetup(glb: Uint8Array): Setup {
  return (gpu: Gpu, _input: Input, _audio: Audio): Frame => {
    const renderer = createRenderer(gpu);
    const mesh = renderer.addMesh(parseGlb(glb));
    const world = createWorld();
    const colors = [vec3(0.98, 0.45, 0.09), vec3(0.35, 0.65, 0.98), vec3(0.55, 0.85, 0.4)];
    for (let i = 0; i < 3; i++) {
      const entity = spawn(world);
      world.transforms.set(entity, {
        position: vec3((i - 1) * 2.4, 0, 0),
        rotation: vec3(0, 0, 0),
        scale: vec3(1, 1, 1),
      });
      world.meshes.set(entity, { mesh, color: colors[i] });
    }

    return (frameGpu: Gpu, time: number): boolean => {
      for (const [entity, transform] of world.transforms) {
        transform.rotation = vec3(0, time * (0.6 + entity * 0.3), 0);
        transform.position = vec3(transform.position.x, Math.sin(time * 2 + entity) * 0.25, 0);
      }
      renderer.render(world, { eye: vec3(0, 1.2, 7), target: vec3(0, 0, 0), fovY: 0.8 }, { r: 0.06, g: 0.06, b: 0.1 });
      return true;
    };
  };
}
