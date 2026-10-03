import { BufferUsage, type Color, type Draw, type Gpu, type PipelineOptions, type Setup, type WindowOptions } from "../gpu";

const vertexFormats: GPUVertexFormat[] = ["float32x2", "float32x3", "float32x4"];

export async function loadBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`fetch ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

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
  const depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const pipelines: GPURenderPipeline[] = [];
  const buffers: GPUBuffer[] = [];
  const bindGroups: GPUBindGroup[] = [];
  const depthPipelines = new Set<number>();

  const gpu: Gpu = {
    createBuffer: (usage: number, data: Uint8Array): number => {
      let flags = GPUBufferUsage.COPY_DST;
      if (usage & BufferUsage.Vertex) flags |= GPUBufferUsage.VERTEX;
      if (usage & BufferUsage.Index) flags |= GPUBufferUsage.INDEX;
      if (usage & BufferUsage.Uniform) flags |= GPUBufferUsage.UNIFORM;
      const buffer = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: flags });
      device.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffers.length - 1;
    },
    writeBuffer: (buffer: number, data: Uint8Array): void => {
      const target = buffers[buffer];
      if (target) device.queue.writeBuffer(target, 0, data);
    },
    createPipeline: (pipelineOptions: PipelineOptions): number => {
      const module = device.createShaderModule({ code: pipelineOptions.wgsl });
      const buffersLayout: GPUVertexBufferLayout[] =
        pipelineOptions.stride > 0
          ? [
              {
                arrayStride: pipelineOptions.stride,
                attributes: pipelineOptions.attributes.map((attribute) => ({
                  format: vertexFormats[attribute.format] ?? "float32x3",
                  offset: attribute.offset,
                  shaderLocation: attribute.location,
                })),
              },
            ]
          : [];
      pipelines.push(
        device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs_main", buffers: buffersLayout },
          fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
          primitive: pipelineOptions.depth ? { cullMode: "back" } : {},
          depthStencil: pipelineOptions.depth
            ? { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" }
            : undefined,
        }),
      );
      if (pipelineOptions.depth) depthPipelines.add(pipelines.length - 1);
      return pipelines.length - 1;
    },
    bindUniform: (pipeline: number, buffer: number): number => {
      bindGroups.push(
        device.createBindGroup({
          layout: pipelines[pipeline].getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: buffers[buffer] } }],
        }),
      );
      return bindGroups.length - 1;
    },
    frame: (clear: Color, draws: Draw[]): void => {
      const encoder = device.createCommandEncoder();
      // Pipelines without depth cannot run in a pass with a depth attachment.
      const usesDepth = draws.some((draw) => depthPipelines.has(draw.pipeline));
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: clear.r, g: clear.g, b: clear.b, a: 1 },
          },
        ],
        depthStencilAttachment: usesDepth
          ? { view: depthTexture.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 }
          : undefined,
      });
      for (const draw of draws) {
        const pipeline = pipelines[draw.pipeline];
        if (!pipeline) continue;
        pass.setPipeline(pipeline);
        if (draw.bindGroup >= 0) pass.setBindGroup(0, bindGroups[draw.bindGroup]);
        if (draw.vertexBuffer >= 0) pass.setVertexBuffer(0, buffers[draw.vertexBuffer]);
        if (draw.indexBuffer >= 0) {
          pass.setIndexBuffer(buffers[draw.indexBuffer], "uint32");
          pass.drawIndexed(draw.count);
        } else {
          pass.draw(draw.count);
        }
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    aspect: (): number => canvas.width / Math.max(canvas.height, 1),
  };

  const frame = setup(gpu);
  const start = performance.now();
  const tick = (): void => {
    if (!frame(gpu, (performance.now() - start) / 1000)) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
