import {
  BufferUsage,
  type Color,
  type Draw,
  type Gpu,
  type PipelineOptions,
  type Setup,
  type Texture,
  type WindowOptions,
} from "../gpu";
import type { Audio } from "../audio";
import { type Input, keyCodes, type Look, type Pointer, type Touch } from "../input";
import type { Storage } from "../storage";

// Engine buffers are always plain ArrayBuffer-backed; the casts below satisfy TS 5.9+ WebGPU typings, which reject
// Uint8Array<ArrayBufferLike> (it could be a SharedArrayBuffer).
const vertexFormats: GPUVertexFormat[] = ["float32x2", "float32x3", "float32x4", "float32", "unorm8x4"];

export async function loadBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`fetch ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export interface RunOptions {
  // "fixed" (default): a canvas of the window options' size. "window": the canvas fills the browser window and
  // follows its size; gpu.aspect() reports the current shape.
  fit?: "fixed" | "window";
  // Locks the mouse to the canvas on click, so input.look() reports movement past the window edge.
  pointerLock?: boolean;
}

export async function run(options: WindowOptions, setup: Setup, runOptions: RunOptions = {}): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  document.title = options.title;
  const canvas = document.createElement("canvas");
  const dpr = globalThis.devicePixelRatio ?? 1;
  const fill = runOptions.fit === "window";
  const cssSize = (): [number, number] => (fill ? [window.innerWidth, window.innerHeight] : [options.width, options.height]);
  const sizeCanvas = (): void => {
    const [w, h] = cssSize();
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  };
  if (fill) {
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    canvas.style.display = "block";
  }
  sizeCanvas();
  document.body.appendChild(canvas);

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not create a WebGPU canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const createDepth = (): GPUTexture =>
    device.createTexture({ size: [canvas.width, canvas.height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  let depthTexture = createDepth();
  if (fill) {
    window.addEventListener("resize", (): void => {
      sizeCanvas();
      depthTexture.destroy();
      depthTexture = createDepth();
    });
  }

  const pipelines: GPURenderPipeline[] = [];
  const buffers: GPUBuffer[] = [];
  const bindGroups: GPUBindGroup[] = [];
  const textureViews: GPUTextureView[] = [];
  const textures: (GPUTexture | null)[] = [];
  const textureSmooth: boolean[] = [];
  // Nearest keeps pixel art crisp; linear suits fonts and photos.
  const nearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  const linear = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const uploadTexture = (
    width: number,
    height: number,
    smooth: boolean,
    write: (texture: GPUTexture) => void,
  ): Texture => {
    const texture = device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    write(texture);
    textures.push(texture);
    textureViews.push(texture.createView());
    textureSmooth.push(smooth);
    return { id: textureViews.length - 1, width, height };
  };
  const depthPipelines = new Set<number>();
  const targetDepths = new Map<number, GPUTexture>();

  const gpu: Gpu = {
    createTarget: (width: number, height: number): Texture => {
      const texture = device.createTexture({ size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      textures.push(texture);
      textureViews.push(texture.createView());
      textureSmooth.push(true);
      const id = textureViews.length - 1;
      targetDepths.set(id, device.createTexture({ size: [width, height], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT }));
      return { id, width, height };
    },
    createBuffer: (usage: number, data: Uint8Array): number => {
      let flags = GPUBufferUsage.COPY_DST;
      if (usage & BufferUsage.Vertex) flags |= GPUBufferUsage.VERTEX;
      if (usage & BufferUsage.Index) flags |= GPUBufferUsage.INDEX;
      if (usage & BufferUsage.Uniform) flags |= GPUBufferUsage.UNIFORM;
      const buffer = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: flags });
      device.queue.writeBuffer(buffer, 0, data as Uint8Array<ArrayBuffer>);
      buffers.push(buffer);
      return buffers.length - 1;
    },
    writeBuffer: (buffer: number, data: Uint8Array): void => {
      const target = buffers[buffer];
      if (target) device.queue.writeBuffer(target, 0, data as Uint8Array<ArrayBuffer>);
    },
    destroyBuffer: (buffer: number): void => {
      buffers[buffer]?.destroy();
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
          fragment: {
            module,
            entryPoint: "fs_main",
            targets: [
              {
                format,
                blend: pipelineOptions.blend
                  ? {
                      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    }
                  : undefined,
              },
            ],
          },
          primitive: pipelineOptions.depth ? { cullMode: "back" } : {},
          depthStencil: pipelineOptions.depth
            ? { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" }
            : undefined,
        }),
      );
      if (pipelineOptions.depth) depthPipelines.add(pipelines.length - 1);
      return pipelines.length - 1;
    },
    bind: (pipeline: number, buffer: number, texture: number): number => {
      const entries: GPUBindGroupEntry[] = [];
      if (buffer >= 0) entries.push({ binding: 0, resource: { buffer: buffers[buffer] } });
      if (texture >= 0) {
        entries.push({ binding: 1, resource: textureViews[texture] });
        entries.push({ binding: 2, resource: textureSmooth[texture] ? linear : nearest });
      }
      bindGroups.push(device.createBindGroup({ layout: pipelines[pipeline].getBindGroupLayout(0), entries }));
      return bindGroups.length - 1;
    },
    destroyTexture: (texture: Texture): void => {
      textures[texture.id]?.destroy();
      textures[texture.id] = null;
      targetDepths.get(texture.id)?.destroy();
      targetDepths.delete(texture.id);
    },
    createTexture: (width: number, height: number, rgba: Uint8Array, smooth: boolean): Texture =>
      uploadTexture(width, height, smooth, (texture) =>
        device.queue.writeTexture({ texture }, rgba as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]),
      ),
    createImage: async (png: Uint8Array, smooth: boolean): Promise<Texture> => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }), { premultiplyAlpha: "none" });
      return uploadTexture(bitmap.width, bitmap.height, smooth, (texture) =>
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]),
      );
    },
    frame: (clear: Color, draws: Draw[], target?: Texture): void => {
      const encoder = device.createCommandEncoder();
      const colorView = target ? textureViews[target.id] : context.getCurrentTexture().createView();
      const depthView = target ? (targetDepths.get(target.id) ?? depthTexture).createView() : depthTexture.createView();
      // Pipelines without depth cannot run in a pass with a depth attachment, so a frame that mixes them (a 3D
      // scene under a 2D HUD) splits into consecutive passes: the first clears, the rest load what came before.
      let from = 0;
      let first = true;
      while (from < draws.length || first) {
        const usesDepth = from < draws.length && depthPipelines.has(draws[from].pipeline);
        let to = from;
        while (to < draws.length && depthPipelines.has(draws[to].pipeline) === usesDepth) to++;
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: colorView,
              loadOp: first ? "clear" : "load",
              storeOp: "store",
              clearValue: { r: clear.r, g: clear.g, b: clear.b, a: 1 },
            },
          ],
          depthStencilAttachment: usesDepth
            ? { view: depthView, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 }
            : undefined,
        });
        for (const draw of draws.slice(from, to)) {
          const pipeline = pipelines[draw.pipeline];
          if (!pipeline) continue;
          pass.setPipeline(pipeline);
          if (draw.bindGroup >= 0) pass.setBindGroup(0, bindGroups[draw.bindGroup]);
          if (draw.vertexBuffer >= 0) pass.setVertexBuffer(0, buffers[draw.vertexBuffer]);
          if (draw.indexBuffer >= 0) {
            pass.setIndexBuffer(buffers[draw.indexBuffer], "uint32");
            pass.drawIndexed(draw.count, 1, draw.first);
          } else {
            pass.draw(draw.count, 1, draw.first);
          }
        }
        pass.end();
        first = false;
        from = to;
      }
      device.queue.submit([encoder.finish()]);
    },
    aspect: (): number => canvas.width / Math.max(canvas.height, 1),
  };

  const pressed = new Set<string>();
  // window, not globalThis: with Bun's types loaded, globalThis listeners receive a plain Event.
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (keyCodes.includes(event.code)) event.preventDefault();
    pressed.add(event.code);
  });
  window.addEventListener("keyup", (event: KeyboardEvent) => pressed.delete(event.code));
  window.addEventListener("blur", () => pressed.clear());
  const pointer: Pointer = { x: 0, y: 0, buttons: 0 };
  const trackPointer = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = (event.clientY - rect.top) / rect.height;
    pointer.buttons = event.buttons & 7;
  };
  canvas.addEventListener("pointermove", trackPointer);
  canvas.addEventListener("pointerdown", trackPointer);
  globalThis.addEventListener("pointerup", trackPointer);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  const fingers = new Map<number, Touch>();
  const trackFinger = (event: PointerEvent): void => {
    if (event.pointerType === "mouse") return;
    const rect = canvas.getBoundingClientRect();
    const touch = { id: event.pointerId, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    if (event.type === "pointerup" || event.type === "pointercancel") fingers.delete(event.pointerId);
    else fingers.set(event.pointerId, touch);
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) canvas.addEventListener(type, trackFinger as EventListener);
  canvas.style.touchAction = "none";
  const look = { x: 0, y: 0 };
  globalThis.addEventListener("mousemove", (event: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    look.x += event.movementX;
    look.y += event.movementY;
  });
  if (runOptions.pointerLock) canvas.addEventListener("click", () => canvas.requestPointerLock());
  // Gamepad slots in connection order, matching the native backend.
  const gamepad = (pad: number): Gamepad | null => navigator.getGamepads?.().filter((g) => g !== null)[pad] ?? null;
  const input: Input = {
    down: (key: number): boolean => pressed.has(keyCodes[key] ?? ""),
    firstDown: (): number => {
      for (let key = 0; key < keyCodes.length; key++) if (pressed.has(keyCodes[key])) return key;
      return -1;
    },
    axis: (pad: number, axis: number): number => gamepad(pad)?.axes[axis] ?? 0,
    button: (pad: number, button: number): boolean => gamepad(pad)?.buttons[button]?.pressed ?? false,
    pointer: (): Pointer => ({ x: pointer.x, y: pointer.y, buttons: pointer.buttons }),
    touches: (): Touch[] => [...fingers.values()],
    look: (): Look => {
      const moved = { x: look.x, y: look.y };
      look.x = 0;
      look.y = 0;
      return moved;
    },
  };
  const storagePrefix = `dotframe:${options.title}:`;
  const storage: Storage = {
    get: (key: string): string | null => {
      try {
        return localStorage.getItem(storagePrefix + key);
      } catch {
        return null;
      }
    },
    set: (key: string, value: string): void => {
      try {
        localStorage.setItem(storagePrefix + key, value);
      } catch {
        // Storage can be unavailable (private mode, blocked site data); the game keeps running.
      }
    },
  };

  // Browsers start audio suspended until a user gesture.
  const audioContext = new AudioContext();
  const master = audioContext.createGain();
  master.gain.value = 0.8;
  master.connect(audioContext.destination);
  const resume = (): void => {
    if (audioContext.state === "suspended") audioContext.resume();
    if (music && musicWanted && music.paused) music.play().catch(() => {});
  };
  globalThis.addEventListener("keydown", resume);
  globalThis.addEventListener("pointerdown", resume);
  const sounds: AudioBuffer[] = [];
  const tracks: string[] = [];
  let music: HTMLAudioElement | null = null;
  let musicWanted = false;
  let musicVolume = 1;
  let masterVolume = 0.8;
  const voices = new Map<number, { source: AudioBufferSourceNode; gain: GainNode; panner: StereoPannerNode }>();
  let nextVoice = 1;
  const audio: Audio = {
    start: (sound: number, volume: number, rate: number, loop: boolean): number => {
      const buffer = sounds[sound];
      if (!buffer) return 0;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      source.playbackRate.value = rate;
      const gain = audioContext.createGain();
      gain.gain.value = volume;
      const panner = audioContext.createStereoPanner();
      source.connect(gain).connect(panner).connect(master);
      const id = nextVoice++;
      voices.set(id, { source, gain, panner });
      source.onended = (): void => {
        voices.delete(id);
      };
      source.start();
      return id;
    },
    setVoice: (voice: number, volume: number, pan: number): void => {
      const v = voices.get(voice);
      if (!v) return;
      v.gain.gain.value = volume;
      v.panner.pan.value = Math.max(-1, Math.min(1, pan));
    },
    stopVoice: (voice: number): void => {
      const v = voices.get(voice);
      if (!v) return;
      v.source.stop();
      voices.delete(voice);
    },
    loadSound: async (mp3: Uint8Array): Promise<number> => {
      sounds.push(await audioContext.decodeAudioData(new Uint8Array(mp3).buffer));
      return sounds.length - 1;
    },
    play: (sound: number, volume: number, rate: number): void => {
      const buffer = sounds[sound];
      if (!buffer) return;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gain = audioContext.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(master);
      source.start();
    },
    tone: (frequency: number, duration: number, volume: number): void => {
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      oscillator.connect(gain).connect(master);
      oscillator.start(now);
      oscillator.stop(now + duration);
    },
    loadMusic: async (mp3: Uint8Array): Promise<number> => {
      tracks.push(URL.createObjectURL(new Blob([new Uint8Array(mp3)], { type: "audio/mpeg" })));
      return tracks.length - 1;
    },
    playMusic: (track: number, loop: boolean, volume: number): void => {
      music?.pause();
      const url = tracks[track];
      if (!url) return;
      music = new globalThis.Audio(url);
      music.loop = loop;
      musicVolume = volume;
      music.volume = musicVolume * masterVolume;
      musicWanted = true;
      music.play().catch(() => {});
    },
    stopMusic: (): void => {
      music?.pause();
      music = null;
      musicWanted = false;
    },
    pauseMusic: (paused: boolean): void => {
      musicWanted = !paused;
      if (paused) music?.pause();
      else music?.play().catch(() => {});
    },
    setMusicVolume: (volume: number): void => {
      musicVolume = volume;
      if (music) music.volume = musicVolume * masterVolume;
    },
    setMasterVolume: (volume: number): void => {
      masterVolume = volume;
      master.gain.value = volume;
      if (music) music.volume = musicVolume * masterVolume;
    },
  };

  const frame = setup({ gpu, input, audio, storage });
  const start = performance.now();
  const tick = (): void => {
    if (!frame((performance.now() - start) / 1000)) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
