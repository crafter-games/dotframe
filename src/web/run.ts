import type { Color, Gpu, Setup, WindowOptions } from "../gpu";

export async function run(options: WindowOptions, setup: Setup): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  document.title = options.title;
  const canvas = document.createElement("canvas");
  const dpr = globalThis.devicePixelRatio ?? 1;
  canvas.style.width = `${options.width}px`;
  canvas.style.height = `${options.height}px`;
  canvas.width = Math.round(options.width * dpr);
  canvas.height = Math.round(options.height * dpr);
  document.body.appendChild(canvas);

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not create a WebGPU canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const pipelines: GPURenderPipeline[] = [];
  const gpu: Gpu = {
    createPipeline: (wgsl: string): number => {
      const module = device.createShaderModule({ code: wgsl });
      pipelines.push(
        device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs_main" },
          fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
        }),
      );
      return pipelines.length - 1;
    },
    frame: (clear: Color, pipeline: number, vertexCount: number): void => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: clear.r, g: clear.g, b: clear.b, a: 1 },
          },
        ],
      });
      const selected = pipelines[pipeline];
      if (selected) {
        pass.setPipeline(selected);
        pass.draw(vertexCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };

  const frame = setup(gpu);
  let index = 0;
  const tick = (): void => {
    if (!frame(gpu, index)) return;
    index++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
