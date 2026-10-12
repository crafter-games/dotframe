// Canvas 2D fallback for browsers without WebGPU. createCanvasGpu stands in for the WebGPU backend: images and
// textures work, 3D pipelines and render targets throw a clear error. createDraw2D sees gpu.canvas2d and builds the
// Draw2D below, which draws straight to the canvas with the same coordinates, state rules and SDF text layout as the
// GPU Draw2D, so a 2D game runs unchanged.
import { type Draw2D, type FontSpec, parseColor, parseFont, registerDraw2DFallback, type TextMetrics2D } from "../draw2d";
import type { Color, Draw, Gpu, RenderGpu, Texture } from "../gpu";

type Source = HTMLCanvasElement | ImageBitmap;

interface CanvasGpu extends Gpu {
  canvas2d: true;
  context: CanvasRenderingContext2D;
  sources: (Source | null)[];
  smooth: boolean[];
}

const NEEDS_WEBGPU = "This game draws in 3D and needs WebGPU, which this browser does not have.";

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

export function createCanvasGpu(canvas: HTMLCanvasElement): Gpu {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a Canvas 2D context");
  const sources: (Source | null)[] = [];
  const smooth: boolean[] = [];
  const add = (source: Source, isSmooth: boolean): Texture => {
    sources.push(source);
    smooth.push(isSmooth);
    return { id: sources.length - 1, width: source.width, height: source.height };
  };
  const unsupported = (): never => {
    throw new Error(NEEDS_WEBGPU);
  };
  const gpu: CanvasGpu = {
    canvas2d: true,
    context,
    sources,
    smooth,
    createBuffer: (): number => 0,
    writeBuffer: (): void => {},
    destroyBuffer: (): void => {},
    createPipeline: unsupported,
    bind: unsupported,
    createTexture: (width: number, height: number, rgba: Uint8Array, isSmooth: boolean, mipmaps = false): Texture => {
      const target = canvasOf(width, height);
      const pixels = new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + width * height * 4) as ArrayBuffer), width, height);
      target.getContext("2d")?.putImageData(pixels, 0, 0);
      return add(target, isSmooth || mipmaps);
    },
    destroyTexture: (texture: Texture): void => {
      sources[texture.id] = null;
    },
    frame: (_clear: Color, draws: Draw[]): void => {
      if (draws.length > 0) unsupported();
    },
    createTarget: unsupported,
    aspect: (): number => canvas.width / Math.max(canvas.height, 1),
    mobile: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    createImage: async (png: Uint8Array, isSmooth: boolean, mipmaps = false): Promise<Texture> => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)]), { premultiplyAlpha: "none" });
      return add(bitmap, isSmooth || mipmaps);
    },
  };
  return gpu;
}

interface Glyph {
  code: number;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  advance: number;
}

interface Font {
  atlas: Texture;
  // The atlas' alpha channel, read once, for SDF sampling on the CPU.
  alpha: Uint8ClampedArray | null;
  metrics: { size: number; ascent: number; descent: number; distanceRange: number; glyphs: Glyph[] };
  glyphs: Map<number, Glyph>;
}

interface State {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  fill: string;
  stroke: string;
  lineWidth: number;
  alpha: number;
  font: FontSpec;
  textAlign: string;
  textBaseline: string;
}

// stb_truetype SDF: 0.5 alpha on the outline, 128/distanceRange alpha steps per atlas pixel (as in draw2d.ts).
const SDF_ON_EDGE = 128 / 255;
// Glyph and tint caches are dropped wholesale past this many entries (animated font sizes make new keys).
const CACHE_LIMIT = 4000;

function createCanvasDraw2D(base: RenderGpu, width: number, height: number): Draw2D {
  const gpu = base as CanvasGpu;
  const ctx = gpu.context;
  let logicalWidth = width;
  let logicalHeight = height;
  const fresh = (): State => ({
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, fill: "#000000", stroke: "#000000", lineWidth: 1, alpha: 1,
    font: parseFont("10px sans-serif"), textAlign: "start", textBaseline: "alphabetic",
  });
  let state = fresh();
  const stack: State[] = [];
  const fonts = new Map<string, Font>();
  let defaultFont: Font | null = null;
  const glyphCache = new Map<string, HTMLCanvasElement | null>();
  const tintCache = new Map<string, HTMLCanvasElement>();

  // Logical coordinates span the whole canvas, as in the GPU Draw2D.
  const apply = (): void => {
    const sx = ctx.canvas.width / logicalWidth;
    const sy = ctx.canvas.height / logicalHeight;
    ctx.setTransform(sx * state.a, sy * state.b, sx * state.c, sy * state.d, sx * state.e, sy * state.f);
  };
  const deviceScale = (): number => {
    const sx = ctx.canvas.width / logicalWidth;
    return Math.max(Math.hypot(state.a, state.b), Math.hypot(state.c, state.d)) * sx;
  };

  const resolveFont = (): Font | null => {
    for (const family of state.font.families) {
      const font = fonts.get(family);
      if (font) return font;
    }
    return defaultFont;
  };
  const textWidth = (font: Font, text: string, scale: number): number => {
    let total = 0;
    for (let i = 0; i < text.length; i++) total += (font.glyphs.get(text.charCodeAt(i))?.advance ?? 0) * scale;
    return total;
  };
  const atlasAlpha = (font: Font): Uint8ClampedArray | null => {
    if (font.alpha) return font.alpha;
    const source = gpu.sources[font.atlas.id];
    if (!source) return null;
    const scratch = canvasOf(source.width, source.height).getContext("2d");
    if (!scratch) return null;
    scratch.drawImage(source, 0, 0);
    const rgba = scratch.getImageData(0, 0, source.width, source.height).data;
    const alpha = new Uint8ClampedArray(source.width * source.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    font.alpha = alpha;
    return alpha;
  };
  // A white coverage mask of one glyph at device resolution: the same smoothstep the GPU shader runs per pixel.
  const glyphMask = (font: Font, glyph: Glyph, pixelsPerUnit: number, edge: number, key: string): HTMLCanvasElement | null => {
    const cached = glyphCache.get(key);
    if (cached !== undefined) return cached;
    const alpha = atlasAlpha(font);
    const w = Math.ceil(glyph.width * pixelsPerUnit);
    const h = Math.ceil(glyph.height * pixelsPerUnit);
    if (!alpha || w <= 0 || h <= 0) return null;
    const mask = canvasOf(w, h);
    const mctx = mask.getContext("2d");
    if (!mctx) return null;
    const image = mctx.createImageData(w, h);
    const aw = font.atlas.width;
    const ah = font.atlas.height;
    const smoothing = Math.max((0.75 * SDF_ON_EDGE) / (font.metrics.distanceRange * pixelsPerUnit), 0.001);
    const sample = (x: number, y: number): number => alpha[Math.min(ah - 1, Math.max(0, y)) * aw + Math.min(aw - 1, Math.max(0, x))] / 255;
    for (let py = 0; py < h; py++) {
      const v = glyph.y + ((py + 0.5) / h) * glyph.height - 0.5;
      const y0 = Math.floor(v);
      const fy = v - y0;
      for (let px = 0; px < w; px++) {
        const u = glyph.x + ((px + 0.5) / w) * glyph.width - 0.5;
        const x0 = Math.floor(u);
        const fx = u - x0;
        const top = sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx;
        const bottom = sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx;
        const distance = top * (1 - fy) + bottom * fy;
        const t = Math.min(1, Math.max(0, (distance - (edge - smoothing)) / (2 * smoothing)));
        const o = (py * w + px) * 4;
        image.data[o] = 255;
        image.data[o + 1] = 255;
        image.data[o + 2] = 255;
        image.data[o + 3] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
    mctx.putImageData(image, 0, 0);
    if (glyphCache.size > CACHE_LIMIT) glyphCache.clear();
    glyphCache.set(key, mask);
    return mask;
  };
  // The mask recolored: a solid color cut to the mask's alpha.
  const tinted = (mask: HTMLCanvasElement, color: string, key: string): HTMLCanvasElement => {
    const cached = tintCache.get(key);
    if (cached) return cached;
    const out = canvasOf(mask.width, mask.height);
    const octx = out.getContext("2d");
    if (octx) {
      octx.fillStyle = color;
      octx.fillRect(0, 0, out.width, out.height);
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(mask, 0, 0);
    }
    if (tintCache.size > CACHE_LIMIT) tintCache.clear();
    tintCache.set(key, out);
    return out;
  };
  const drawText = (text: string, x: number, y: number, color: string, outline: number): void => {
    const font = resolveFont();
    if (!font) return;
    const scale = state.font.size / font.metrics.size;
    let penX = x;
    const total = textWidth(font, text, scale);
    if (state.textAlign === "center") penX -= total / 2;
    else if (state.textAlign === "right" || state.textAlign === "end") penX -= total;
    let baseline = y;
    if (state.textBaseline === "middle") baseline += ((font.metrics.ascent + font.metrics.descent) / 2) * scale;
    else if (state.textBaseline === "top" || state.textBaseline === "hanging") baseline += font.metrics.ascent * scale;
    else if (state.textBaseline === "bottom" || state.textBaseline === "ideographic") baseline += font.metrics.descent * scale;
    const stepsPerPixel = 128 / font.metrics.distanceRange / 255;
    const edge = Math.max(0.02, SDF_ON_EDGE - (outline / scale) * stepsPerPixel);
    // Masks are cached per whole device pixel size, so text drawn at one size reuses them every frame.
    const pixelsPerUnit = Math.max(1, Math.round(scale * deviceScale() * 4)) / 4;
    const fontKey = font.atlas.id;
    ctx.globalAlpha = state.alpha;
    for (let i = 0; i < text.length; i++) {
      const glyph = font.glyphs.get(text.charCodeAt(i));
      if (!glyph) continue;
      if (glyph.width > 0) {
        const key = `${fontKey}:${glyph.code}:${pixelsPerUnit}:${edge.toFixed(3)}`;
        const mask = glyphMask(font, glyph, pixelsPerUnit, edge, key);
        if (mask) {
          const image = tinted(mask, color, `${key}:${color}`);
          const gx = penX + glyph.offsetX * scale;
          const gy = baseline + glyph.offsetY * scale;
          if (state.b === 0 && state.c === 0) {
            // Unrotated: place the mask 1:1 on whole device pixels, so text stays as sharp as the GPU's.
            const sx = ctx.canvas.width / logicalWidth;
            const sy = ctx.canvas.height / logicalHeight;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(image, Math.round(sx * (state.a * gx + state.e)), Math.round(sy * (state.d * gy + state.f)));
            apply();
          } else ctx.drawImage(image, gx, gy, glyph.width * scale, glyph.height * scale);
        }
      }
      penX += glyph.advance * scale;
    }
  };
  const source = (texture: Texture): Source | null => gpu.sources[texture.id] ?? null;

  return {
    resize: (w: number, h: number): void => {
      logicalWidth = w;
      logicalHeight = h;
    },
    begin: (): void => {
      state = fresh();
      stack.length = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      apply();
    },
    end: (clear: Color, target?: Texture): void => {
      if (target) throw new Error(NEEDS_WEBGPU);
      // The clear color goes behind everything drawn this frame, which blends the same as clearing first.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = `rgb(${Math.round(clear.r * 255)}, ${Math.round(clear.g * 255)}, ${Math.round(clear.b * 255)})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.globalCompositeOperation = "source-over";
    },
    scene: (draws: Draw[]): void => {
      if (draws.length > 0) throw new Error(NEEDS_WEBGPU);
    },
    save: (): void => {
      stack.push({ ...state });
    },
    restore: (): void => {
      const previous = stack.pop();
      if (previous) state = previous;
      apply();
    },
    translate: (x: number, y: number): void => {
      state.e += state.a * x + state.c * y;
      state.f += state.b * x + state.d * y;
      apply();
    },
    rotate: (radians: number): void => {
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const { a, b, c, d } = state;
      state.a = a * cos + c * sin;
      state.b = b * cos + d * sin;
      state.c = c * cos - a * sin;
      state.d = d * cos - b * sin;
      apply();
    },
    scale: (x: number, y: number): void => {
      state.a *= x;
      state.b *= x;
      state.c *= y;
      state.d *= y;
      apply();
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number): void => {
      state.a = a;
      state.b = b;
      state.c = c;
      state.d = d;
      state.e = e;
      state.f = f;
      apply();
    },
    resetTransform: (): void => {
      state.a = 1;
      state.b = 0;
      state.c = 0;
      state.d = 1;
      state.e = 0;
      state.f = 0;
      apply();
    },
    setFillStyle: (color: string): void => {
      state.fill = color;
    },
    setStrokeStyle: (color: string): void => {
      state.stroke = color;
    },
    setLineWidth: (lineWidth: number): void => {
      state.lineWidth = lineWidth;
    },
    setGlobalAlpha: (alpha: number): void => {
      state.alpha = alpha;
    },
    getGlobalAlpha: (): number => state.alpha,
    fillRect: (x: number, y: number, w: number, h: number): void => {
      ctx.globalAlpha = state.alpha;
      ctx.fillStyle = state.fill;
      ctx.fillRect(x, y, w, h);
    },
    strokeRect: (x: number, y: number, w: number, h: number): void => {
      ctx.globalAlpha = state.alpha;
      ctx.strokeStyle = state.stroke;
      ctx.lineWidth = state.lineWidth;
      ctx.strokeRect(x, y, w, h);
    },
    beginPath: (): void => ctx.beginPath(),
    moveTo: (x: number, y: number): void => ctx.moveTo(x, y),
    lineTo: (x: number, y: number): void => ctx.lineTo(x, y),
    rect: (x: number, y: number, w: number, h: number): void => ctx.rect(x, y, w, h),
    arc: (x: number, y: number, radius: number, start: number, end: number, counterclockwise: boolean): void =>
      ctx.arc(x, y, Math.max(0, radius), start, end, counterclockwise),
    ellipse: (x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, counterclockwise: boolean): void =>
      ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rotation, start, end, counterclockwise),
    closePath: (): void => ctx.closePath(),
    fill: (): void => {
      ctx.globalAlpha = state.alpha;
      ctx.fillStyle = state.fill;
      ctx.fill();
    },
    stroke: (): void => {
      ctx.globalAlpha = state.alpha;
      ctx.strokeStyle = state.stroke;
      ctx.lineWidth = state.lineWidth;
      ctx.stroke();
    },
    drawImageTinted: (image: Texture, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, color: string): void => {
      const from = source(image);
      if (!from) return;
      const key = `image:${image.id}:${color}`;
      let silhouette = tintCache.get(key);
      if (!silhouette) {
        silhouette = canvasOf(from.width, from.height);
        const sctx = silhouette.getContext("2d");
        if (sctx) {
          sctx.drawImage(from, 0, 0);
          sctx.globalCompositeOperation = "source-in";
          sctx.fillStyle = color;
          sctx.fillRect(0, 0, from.width, from.height);
        }
        tintCache.set(key, silhouette);
      }
      ctx.globalAlpha = state.alpha * parseColor(color).a;
      ctx.imageSmoothingEnabled = gpu.smooth[image.id] ?? true;
      ctx.drawImage(silhouette, sx, sy, sw, sh, dx, dy, dw, dh);
    },
    addFont: (families: string[], atlas: Texture, metricsJson: string): void => {
      const metrics = JSON.parse(metricsJson) as Font["metrics"];
      const glyphs = new Map<number, Glyph>();
      for (const glyph of metrics.glyphs) glyphs.set(glyph.code, glyph);
      const font: Font = { atlas, alpha: null, metrics, glyphs };
      for (const family of families) fonts.set(family.toLowerCase(), font);
      if (!defaultFont) defaultFont = font;
    },
    setFont: (font: string): void => {
      state.font = parseFont(font);
    },
    setTextAlign: (align: string): void => {
      state.textAlign = align;
    },
    setTextBaseline: (baseline: string): void => {
      state.textBaseline = baseline;
    },
    fillText: (text: string, x: number, y: number): void => drawText(text, x, y, state.fill, 0),
    strokeText: (text: string, x: number, y: number): void => drawText(text, x, y, state.stroke, state.lineWidth / 2),
    measureText: (text: string): TextMetrics2D => {
      const font = resolveFont();
      return { width: font ? textWidth(font, text, state.font.size / font.metrics.size) : 0 };
    },
    drawImage: (image: Texture, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void => {
      const from = source(image);
      if (!from) return;
      ctx.globalAlpha = state.alpha;
      ctx.imageSmoothingEnabled = gpu.smooth[image.id] ?? true;
      ctx.drawImage(from, sx, sy, sw, sh, dx, dy, dw, dh);
    },
  };
}

registerDraw2DFallback(createCanvasDraw2D);
