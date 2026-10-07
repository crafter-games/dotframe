import { BufferUsage, type Color, type Draw, type RenderGpu, type Texture, VertexFormat } from "./gpu";

// Immediate-mode 2D drawing modeled on the Canvas2D API, so Canvas2D games port mechanically.
// Coordinates are logical pixels (top-left origin) mapped onto the whole surface.
// State setters replace Canvas2D property assignment: setFillStyle("#fff") for ctx.fillStyle = "#fff".

export interface Draw2D {
  begin: () => void;
  // Changes the logical canvas size (for a window that resizes); coordinates map onto the whole surface.
  resize: (width: number, height: number) => void;
  end: (clear: Color) => void;
  // Queues draws from another renderer (a 3D scene) to run before this frame's 2D shapes, so the HUD lands on top.
  scene: (draws: Draw[]) => void;
  save: () => void;
  restore: () => void;
  translate: (x: number, y: number) => void;
  rotate: (radians: number) => void;
  scale: (x: number, y: number) => void;
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  resetTransform: () => void;
  setFillStyle: (color: string) => void;
  setStrokeStyle: (color: string) => void;
  setLineWidth: (width: number) => void;
  setGlobalAlpha: (alpha: number) => void;
  getGlobalAlpha: () => number;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  strokeRect: (x: number, y: number, width: number, height: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  rect: (x: number, y: number, width: number, height: number) => void;
  arc: (x: number, y: number, radius: number, start: number, end: number, counterclockwise: boolean) => void;
  ellipse: (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
  ) => void;
  closePath: () => void;
  fill: () => void;
  stroke: () => void;
  // drawImage drawn as a solid-color silhouette of the image's alpha.
  drawImageTinted: (
    image: Texture,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    color: string,
  ) => void;
  // Registers an SDF font baked by tools/bake-font.c under one or more CSS family names.
  addFont: (families: string[], atlas: Texture, metricsJson: string) => void;
  // CSS font shorthand, e.g. 'italic 900 24px "Arial Black", Impact, sans-serif'.
  setFont: (font: string) => void;
  setTextAlign: (align: string) => void;
  setTextBaseline: (baseline: string) => void;
  fillText: (text: string, x: number, y: number) => void;
  strokeText: (text: string, x: number, y: number) => void;
  measureText: (text: string) => TextMetrics2D;
  drawImage: (
    image: Texture,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) => void;
}

export interface TextMetrics2D {
  width: number;
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

interface FontMetrics {
  size: number;
  ascent: number;
  descent: number;
  distanceRange: number;
  glyphs: Glyph[];
}

interface Font {
  atlas: Texture;
  metrics: FontMetrics;
  glyphs: Map<number, Glyph>;
}

export interface FontSpec {
  size: number;
  italic: boolean;
  families: string[];
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface State {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  fill: Rgba;
  stroke: Rgba;
  lineWidth: number;
  alpha: number;
  font: FontSpec;
  textAlign: string;
  textBaseline: string;
}

interface Batch {
  texture: number;
  first: number;
  count: number;
}

const shader = `
struct Uniforms { size: vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) edge: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) edge: f32,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position.x / u.size.x * 2.0 - 1.0, 1.0 - position.y / u.size.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  out.color = color;
  out.edge = edge;
  return out;
}

// edge >= 0: signed distance field cut at that alpha. -1: texture times color. -2: color with the texture's alpha
// (a silhouette, like Canvas2D's source-in over an image).
@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let sample = textureSample(tex, samp, in.uv);
  let distance = sample.a;
  let smoothing = max(fwidth(distance) * 0.75, 0.001);
  let coverage = smoothstep(in.edge - smoothing, in.edge + smoothing, distance);
  if (in.edge < -1.5) {
    return vec4f(in.color.rgb, in.color.a * sample.a);
  }
  if (in.edge < 0.0) {
    return sample * in.color;
  }
  return vec4f(in.color.rgb, in.color.a * coverage);
}
`;

// Vertex layout, in 4-byte words: position (2 × f32), uv (2 × f32), color packed as unorm8x4, edge (f32).
const WORDS_PER_VERTEX = 6;
const COLOR_WORD = 4;
const EDGE_WORD = 5;

// Packs a color with components in [0, 1] into the unorm8x4 word the shader reads as a vec4f. Consecutive
// draw calls almost always share a color, so the last result is reused.
const lastColor = new Float64Array(5);
lastColor[0] = -1;
function packColor(r: number, g: number, b: number, a: number): number {
  const memo = lastColor;
  if (r === memo[0] && g === memo[1] && b === memo[2] && a === memo[3]) return memo[4];
  const packed = computeColor(r, g, b, a);
  memo[0] = r;
  memo[1] = g;
  memo[2] = b;
  memo[3] = a;
  memo[4] = packed;
  return packed;
}

function computeColor(r: number, g: number, b: number, a: number): number {
  const R = Math.round(Math.min(Math.max(r, 0), 1) * 255);
  const G = Math.round(Math.min(Math.max(g, 0), 1) * 255);
  const B = Math.round(Math.min(Math.max(b, 0), 1) * 255);
  const A = Math.round(Math.min(Math.max(a, 0), 1) * 255);
  return (R | (G << 8) | (B << 16) | (A << 24)) >>> 0;
}
const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
// stb_truetype SDF: 0.5 alpha on the outline, 128/distanceRange alpha steps per atlas pixel.
const SDF_ON_EDGE = 128 / 255;
const INITIAL_VERTICES = 65536;
const MAX_VERTICES = 4194304;
const MAX_CURVE_SEGMENTS = 64;

const named: Map<string, string> = new Map([
  ["white", "#ffffff"],
  ["black", "#000000"],
  ["red", "#ff0000"],
  ["green", "#008000"],
  ["blue", "#0000ff"],
  ["yellow", "#ffff00"],
  ["orange", "#ffa500"],
  ["purple", "#800080"],
  ["gray", "#808080"],
  ["grey", "#808080"],
  ["transparent", "#00000000"],
]);

function hexByte(text: string, start: number, length: number): number {
  const digits = "0123456789abcdef";
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 16 + digits.indexOf(text[start + i]);
  return length === 1 ? value * 17 : value;
}

// Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba() and a few names.
export function parseColor(input: string): Rgba {
  const text = (named.get(input.trim().toLowerCase()) ?? input).trim().toLowerCase();
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const step = hex.length <= 4 ? 1 : 2;
    const r = hexByte(hex, 0, step);
    const g = hexByte(hex, step, step);
    const b = hexByte(hex, step * 2, step);
    const a = hex.length === 4 || hex.length === 8 ? hexByte(hex, step * 3, step) : 255;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open > 0 && close > open) {
    const parts = text.slice(open + 1, close).split(",");
    const channel = (index: number): number => Number((parts[index] ?? "0").trim().split("%").join(""));
    const alpha = parts.length > 3 ? channel(3) : 1;
    if (text.startsWith("hsl")) {
      // hsl(h, s%, l%) per CSS Color 4.
      const h = (((channel(0) % 360) + 360) % 360) / 360;
      const sat = channel(1) / 100;
      const light = channel(2) / 100;
      const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
      const p = 2 * light - q;
      const hue = (t: number): number => {
        const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        if (u < 1 / 6) return p + (q - p) * 6 * u;
        if (u < 1 / 2) return q;
        if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
        return p;
      };
      return { r: hue(h + 1 / 3), g: hue(h), b: hue(h - 1 / 3), a: alpha };
    }
    return { r: channel(0) / 255, g: channel(1) / 255, b: channel(2) / 255, a: alpha };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Ear clipping over a simple polygon given as flat [x0, y0, x1, y1, ...]. Returns triangle vertex indices.
export function triangulate(points: number[]): number[] {
  const count = points.length / 2;
  const result: number[] = [];
  if (count < 3) return result;
  let area = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  const winding = area >= 0 ? 1 : -1;
  const remaining: number[] = [];
  for (let i = 0; i < count; i++) remaining.push(i);

  const cross = (a: number, b: number, c: number): number =>
    (points[b * 2] - points[a * 2]) * (points[c * 2 + 1] - points[a * 2 + 1]) -
    (points[b * 2 + 1] - points[a * 2 + 1]) * (points[c * 2] - points[a * 2]);
  const inside = (p: number, a: number, b: number, c: number): boolean =>
    cross(a, b, p) * winding > 0 && cross(b, c, p) * winding > 0 && cross(c, a, p) * winding > 0;

  let guard = 0;
  while (remaining.length > 3 && guard < count * count) {
    guard++;
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length];
      const b = remaining[i];
      const c = remaining[(i + 1) % remaining.length];
      if (cross(a, b, c) * winding <= 0) continue;
      let blocked = false;
      for (const p of remaining) {
        if (p !== a && p !== b && p !== c && inside(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      result.push(a, b, c);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate input: fall back to a fan over what is left.
    if (!clipped) break;
  }
  for (let i = 1; i + 1 < remaining.length; i++) result.push(remaining[0], remaining[i], remaining[i + 1]);
  return result;
}

// Parses the size, italic flag and family list out of a CSS font shorthand.
export function parseFont(font: string): FontSpec {
  const pxIndex = font.indexOf("px");
  let start = pxIndex;
  while (start > 0 && "0123456789.".includes(font[start - 1])) start--;
  const size = pxIndex > 0 ? Number(font.slice(start, pxIndex)) : 10;
  const families: string[] = [];
  for (const part of font.slice(pxIndex > 0 ? pxIndex + 2 : 0).split(",")) {
    const name = part.trim().split('"').join("").split("'").join("");
    if (name.length > 0) families.push(name.toLowerCase());
  }
  return { size, italic: font.slice(0, Math.max(start, 0)).includes("italic"), families };
}

export function createDraw2D(gpu: RenderGpu, width: number, height: number): Draw2D {
  const pipeline = gpu.createPipeline({
    wgsl: shader,
    stride: WORDS_PER_VERTEX * 4,
    attributes: [
      { format: VertexFormat.Float32x2, offset: 0, location: 0 },
      { format: VertexFormat.Float32x2, offset: 8, location: 1 },
      { format: VertexFormat.Unorm8x4, offset: COLOR_WORD * 4, location: 2 },
      { format: VertexFormat.Float32, offset: EDGE_WORD * 4, location: 3 },
    ],
    depth: false,
    blend: true,
  });
  // Grows by doubling when a frame needs more room; the GPU buffer is recreated to match at the end of the frame.
  let capacity = INITIAL_VERTICES;
  let vertices = new Float32Array(capacity * WORDS_PER_VERTEX);
  // The same memory as words, for packed colors.
  let words = new Uint32Array(vertices.buffer);
  let vertexBuffer = gpu.createBuffer(BufferUsage.Vertex, new Uint8Array(vertices.byteLength));
  let gpuCapacity = capacity;
  const grow = (needed: number): boolean => {
    if (needed <= capacity) return true;
    if (needed > MAX_VERTICES) return false;
    while (capacity < needed) capacity *= 2;
    const larger = new Float32Array(capacity * WORDS_PER_VERTEX);
    larger.set(vertices.subarray(0, vertexCount * WORDS_PER_VERTEX));
    vertices = larger;
    words = new Uint32Array(larger.buffer);
    return true;
  };
  const uniforms = new Float32Array([width, height, 0, 0]);
  const uniformBuffer = gpu.createBuffer(
    BufferUsage.Uniform,
    new Uint8Array(uniforms.buffer, uniforms.byteOffset, uniforms.byteLength),
  );
  const white = gpu.createTexture(1, 1, new Uint8Array([255, 255, 255, 255]), false);
  const bindGroups = new Map<number, number>();
  const bindGroupFor = (texture: number): number => {
    let group = bindGroups.get(texture);
    if (group === undefined) {
      group = gpu.bind(pipeline, uniformBuffer, texture);
      bindGroups.set(texture, group);
    }
    return group;
  };

  const initialState = (): State => ({
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
    fill: { r: 0, g: 0, b: 0, a: 1 },
    stroke: { r: 0, g: 0, b: 0, a: 1 },
    lineWidth: 1,
    alpha: 1,
    font: { size: 10, italic: false, families: ["sans-serif"] },
    textAlign: "start",
    textBaseline: "alphabetic",
  });
  const fonts = new Map<string, Font>();
  let defaultFont: Font | null = null;
  let state = initialState();
  const stack: State[] = [];
  let vertexCount = 0;
  const under: Draw[] = [];
  const batches: Batch[] = [];
  // Current path, in path (untransformed) space: every point of every subpath in one flat x,y buffer. Points
  // are only ever appended to the last subpath, so subpath s spans [starts[s], starts[s + 1]) and the last one
  // ends at pathLength. A typed buffer keeps point reads and writes inline in compiled builds.
  let pathData = new Float64Array(1024);
  let pathLength = 0;
  const starts: number[] = [];
  const closed: boolean[] = [];
  // A subpath built only from one arc, ellipse or rect is convex and fills as a fan, skipping ear clipping.
  const convex: boolean[] = [];
  let subpathCount = 0;
  const startSubpath = (isClosed: boolean, isConvex: boolean): void => {
    if (subpathCount === starts.length) {
      starts.push(0);
      closed.push(false);
      convex.push(false);
    }
    starts[subpathCount] = pathLength;
    closed[subpathCount] = isClosed;
    convex[subpathCount] = isConvex;
    subpathCount++;
  };
  // Room for `floats` more values in the path buffer.
  const reservePath = (floats: number): Float64Array => {
    if (pathLength + floats > pathData.length) {
      let size = pathData.length * 2;
      while (size < pathLength + floats) size *= 2;
      const larger = new Float64Array(size);
      larger.set(pathData.subarray(0, pathLength));
      pathData = larger;
    }
    return pathData;
  };
  const pushPoint = (x: number, y: number): void => {
    const data = reservePath(2);
    data[pathLength] = x;
    data[pathLength + 1] = y;
    pathLength = pathLength + 2;
  };
  const subpathStart = (s: number): number => starts[s];
  const subpathEnd = (s: number): number => (s + 1 < subpathCount ? starts[s + 1] : pathLength);

  const vertex = (x: number, y: number, u: number, v: number, color: Rgba, edge: number): void => {
    if (vertexCount >= capacity) return;
    // Local aliases: each access to a captured binding costs an indirection plus a retain in compiled builds.
    const out = vertices;
    const t = state;
    const o = vertexCount * WORDS_PER_VERTEX;
    out[o] = t.a * x + t.c * y + t.e;
    out[o + 1] = t.b * x + t.d * y + t.f;
    out[o + 2] = u;
    out[o + 3] = v;
    words[o + COLOR_WORD] = packColor(color.r, color.g, color.b, color.a * t.alpha);
    out[o + EDGE_WORD] = edge;
    vertexCount = vertexCount + 1;
  };

  // Writes two triangles for the quad (x0,y0)-(x1,y1)-(x2,y2)-(x3,y3) with texture corners (u0,v0)-(u1,v1),
  // transforming each corner once. The caller has reserved 6 vertices with useTexture.
  const emitQuad = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: Rgba,
    edge: number,
  ): void => {
    if (vertexCount + 6 > capacity) return;
    const out = vertices;
    const t = state;
    const ax = t.a * x0 + t.c * y0 + t.e;
    const ay = t.b * x0 + t.d * y0 + t.f;
    const bx = t.a * x1 + t.c * y1 + t.e;
    const by = t.b * x1 + t.d * y1 + t.f;
    const cx = t.a * x2 + t.c * y2 + t.e;
    const cy = t.b * x2 + t.d * y2 + t.f;
    const dx = t.a * x3 + t.c * y3 + t.e;
    const dy = t.b * x3 + t.d * y3 + t.f;
    const packed = words;
    const rgba = packColor(color.r, color.g, color.b, color.a * t.alpha);
    let o = vertexCount * WORDS_PER_VERTEX;
    // Corner order: a b c, a c d.
    for (let k = 0; k < 6; k++) {
      const corner = k === 0 || k === 3 ? 0 : k === 1 ? 1 : k === 2 || k === 4 ? 2 : 3;
      out[o] = corner === 0 ? ax : corner === 1 ? bx : corner === 2 ? cx : dx;
      out[o + 1] = corner === 0 ? ay : corner === 1 ? by : corner === 2 ? cy : dy;
      out[o + 2] = corner === 0 || corner === 3 ? u0 : u1;
      out[o + 3] = corner === 0 || corner === 1 ? v0 : v1;
      packed[o + COLOR_WORD] = rgba;
      out[o + EDGE_WORD] = edge;
      o += WORDS_PER_VERTEX;
    }
    vertexCount = vertexCount + 6;
  };

  // The batch being filled lives in plain numbers and joins `batches` only when the texture changes: reading
  // the array's last element back on every draw call costs an allocation in compiled builds.
  let openTexture = -1;
  let openFirst = 0;
  let openCount = 0;
  const closeBatch = (): void => {
    if (openCount > 0) batches.push({ texture: openTexture, first: openFirst, count: openCount });
    openCount = 0;
  };

  // Reserves room for whole triangles on the given texture, starting a new batch when it changes.
  const useTexture = (texture: number, triangleVertices: number): boolean => {
    if (!grow(vertexCount + triangleVertices)) return false;
    if (openCount === 0 || texture !== openTexture) {
      closeBatch();
      openTexture = texture;
      openFirst = vertexCount;
    }
    openCount = openCount + triangleVertices;
    return true;
  };

  const quad = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    color: Rgba,
  ): void => {
    if (!useTexture(white.id, 6)) return;
    emitQuad(x0, y0, x1, y1, x2, y2, x3, y3, 0, 0, 0, 0, color, -1);
  };

  const strokeSegment = (ax: number, ay: number, bx: number, by: number): void => {
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    const half = state.lineWidth / 2;
    const nx = (-dy / length) * half;
    const ny = (dx / length) * half;
    quad(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, state.stroke);
  };

  const ensureSubpath = (): void => {
    if (subpathCount === 0) startSubpath(false, true);
  };

  const arcPoints = (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
  ): void => {
    let sweep = end - start;
    const full = Math.PI * 2;
    if (!counterclockwise && sweep < 0) sweep = (sweep % full) + full;
    if (counterclockwise && sweep > 0) sweep = (sweep % full) - full;
    if (Math.abs(end - start) >= full) sweep = counterclockwise ? -full : full;
    // Segment count follows the on-screen radius, as Canvas2D does: small circles stay cheap, large ones smooth.
    const screenRadius = Math.max(radiusX, radiusY) * Math.sqrt(Math.abs(state.a * state.d - state.b * state.c));
    const segments = Math.min(MAX_CURVE_SEGMENTS, Math.max(8, Math.ceil(screenRadius * 1.5)));
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / full) * segments));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    ensureSubpath();
    // Arcs appended to existing points (rounded shapes, pie slices) may be concave.
    if (pathLength > starts[subpathCount - 1]) convex[subpathCount - 1] = false;
    const data = reservePath((steps + 1) * 2);
    let o = pathLength;
    for (let i = 0; i <= steps; i++) {
      const angle = start + (sweep * i) / steps;
      const px = Math.cos(angle) * radiusX;
      const py = Math.sin(angle) * radiusY;
      data[o] = x + px * cos - py * sin;
      data[o + 1] = y + px * sin + py * cos;
      o += 2;
    }
    pathLength = o;
  };

  const resolveFont = (): Font | null => {
    for (const family of state.font.families) {
      const font = fonts.get(family);
      if (font) return font;
    }
    return defaultFont;
  };

  const textWidth = (font: Font, text: string, scale: number): number => {
    let width = 0;
    for (let i = 0; i < text.length; i++) width += (font.glyphs.get(text.charCodeAt(i))?.advance ?? 0) * scale;
    return width;
  };

  const drawText = (text: string, x: number, y: number, color: Rgba, outline: number): void => {
    const font = resolveFont();
    if (!font) return;
    const scale = state.font.size / font.metrics.size;
    const width = textWidth(font, text, scale);
    let penX = x;
    if (state.textAlign === "center") penX -= width / 2;
    else if (state.textAlign === "right" || state.textAlign === "end") penX -= width;
    let baseline = y;
    if (state.textBaseline === "middle") baseline += ((font.metrics.ascent + font.metrics.descent) / 2) * scale;
    else if (state.textBaseline === "top" || state.textBaseline === "hanging") baseline += font.metrics.ascent * scale;
    else if (state.textBaseline === "bottom" || state.textBaseline === "ideographic") baseline += font.metrics.descent * scale;
    const stepsPerPixel = 128 / font.metrics.distanceRange / 255;
    const edge = Math.max(0.02, SDF_ON_EDGE - (outline / scale) * stepsPerPixel);
    const skew = state.font.italic ? 0.2 : 0;
    const atlasWidth = font.atlas.width;
    const atlasHeight = font.atlas.height;
    for (let i = 0; i < text.length; i++) {
      const glyph = font.glyphs.get(text.charCodeAt(i));
      if (!glyph) continue;
      if (glyph.width > 0 && useTexture(font.atlas.id, 6)) {
        const x0 = penX + glyph.offsetX * scale;
        const y0 = baseline + glyph.offsetY * scale;
        const x1 = x0 + glyph.width * scale;
        const y1 = y0 + glyph.height * scale;
        const u0 = glyph.x / atlasWidth;
        const v0 = glyph.y / atlasHeight;
        const u1 = (glyph.x + glyph.width) / atlasWidth;
        const v1 = (glyph.y + glyph.height) / atlasHeight;
        const top = (baseline - y0) * skew;
        const bottom = (baseline - y1) * skew;
        emitQuad(x0 + top, y0, x1 + top, y0, x1 + bottom, y1, x0 + bottom, y1, u0, v0, u1, v1, color, edge);
      }
      penX += glyph.advance * scale;
    }
  };

  return {
    resize: (w: number, h: number): void => {
      uniforms[0] = w;
      uniforms[1] = h;
      gpu.writeBuffer(uniformBuffer, new Uint8Array(uniforms.buffer, uniforms.byteOffset, uniforms.byteLength));
    },
    begin: (): void => {
      vertexCount = 0;
      batches.length = 0;
      openCount = 0;
      state = initialState();
      stack.length = 0;
      under.length = 0;
    },
    scene: (draws: Draw[]): void => {
      for (const draw of draws) under.push(draw);
    },
    end: (clear: Color): void => {
      if (gpuCapacity < capacity) {
        gpu.destroyBuffer(vertexBuffer);
        vertexBuffer = gpu.createBuffer(BufferUsage.Vertex, new Uint8Array(capacity * WORDS_PER_VERTEX * 4));
        gpuCapacity = capacity;
      }
      closeBatch();
      gpu.writeBuffer(vertexBuffer, new Uint8Array(vertices.buffer, 0, vertexCount * WORDS_PER_VERTEX * 4));
      const draws: Draw[] = [...under];
      for (const batch of batches) {
        draws.push({
          pipeline,
          bindGroup: bindGroupFor(batch.texture),
          vertexBuffer,
          indexBuffer: -1,
          first: batch.first,
          count: batch.count,
        });
      }
      gpu.frame(clear, draws);
    },
    save: (): void => {
      stack.push({ ...state });
    },
    restore: (): void => {
      const previous = stack.pop();
      if (previous) state = previous;
    },
    translate: (x: number, y: number): void => {
      state.e += state.a * x + state.c * y;
      state.f += state.b * x + state.d * y;
    },
    rotate: (radians: number): void => {
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const a = state.a * cos + state.c * sin;
      const b = state.b * cos + state.d * sin;
      const c = state.c * cos - state.a * sin;
      const d = state.d * cos - state.b * sin;
      state.a = a;
      state.b = b;
      state.c = c;
      state.d = d;
    },
    scale: (x: number, y: number): void => {
      state.a *= x;
      state.b *= x;
      state.c *= y;
      state.d *= y;
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number): void => {
      state.a = a;
      state.b = b;
      state.c = c;
      state.d = d;
      state.e = e;
      state.f = f;
    },
    resetTransform: (): void => {
      state.a = 1;
      state.b = 0;
      state.c = 0;
      state.d = 1;
      state.e = 0;
      state.f = 0;
    },
    setFillStyle: (color: string): void => {
      state.fill = parseColor(color);
    },
    setStrokeStyle: (color: string): void => {
      state.stroke = parseColor(color);
    },
    setLineWidth: (lineWidth: number): void => {
      state.lineWidth = lineWidth;
    },
    setGlobalAlpha: (alpha: number): void => {
      state.alpha = alpha;
    },
    getGlobalAlpha: (): number => state.alpha,
    fillRect: (x: number, y: number, w: number, h: number): void => {
      quad(x, y, x + w, y, x + w, y + h, x, y + h, state.fill);
    },
    strokeRect: (x: number, y: number, w: number, h: number): void => {
      strokeSegment(x, y, x + w, y);
      strokeSegment(x + w, y, x + w, y + h);
      strokeSegment(x + w, y + h, x, y + h);
      strokeSegment(x, y + h, x, y);
    },
    beginPath: (): void => {
      subpathCount = 0;
      pathLength = 0;
    },
    moveTo: (x: number, y: number): void => {
      startSubpath(false, false);
      pushPoint(x, y);
    },
    lineTo: (x: number, y: number): void => {
      ensureSubpath();
      pushPoint(x, y);
      convex[subpathCount - 1] = false;
    },
    rect: (x: number, y: number, w: number, h: number): void => {
      startSubpath(true, true);
      pushPoint(x, y);
      pushPoint(x + w, y);
      pushPoint(x + w, y + h);
      pushPoint(x, y + h);
    },
    arc: (x: number, y: number, radius: number, start: number, end: number, counterclockwise: boolean): void => {
      arcPoints(x, y, radius, radius, 0, start, end, counterclockwise);
    },
    ellipse: (
      x: number,
      y: number,
      radiusX: number,
      radiusY: number,
      rotation: number,
      start: number,
      end: number,
      counterclockwise: boolean,
    ): void => {
      arcPoints(x, y, radiusX, radiusY, rotation, start, end, counterclockwise);
    },
    closePath: (): void => {
      if (subpathCount > 0) closed[subpathCount - 1] = true;
    },
    fill: (): void => {
      for (let s = 0; s < subpathCount; s++) {
        const points = pathData;
        const base = subpathStart(s);
        const count = (subpathEnd(s) - base) / 2;
        if (convex[s] && count >= 3) {
          const total = (count - 2) * 3;
          if (!useTexture(white.id, total) || vertexCount + total > capacity) return;
          const out = vertices;
          const t = state;
          const fill = t.fill;
          const packed = words;
          const rgba = packColor(fill.r, fill.g, fill.b, fill.a * t.alpha);
          const fx = t.a * points[base] + t.c * points[base + 1] + t.e;
          const fy = t.b * points[base] + t.d * points[base + 1] + t.f;
          let px = t.a * points[base + 2] + t.c * points[base + 3] + t.e;
          let py = t.b * points[base + 2] + t.d * points[base + 3] + t.f;
          let o = vertexCount * WORDS_PER_VERTEX;
          for (let i = 1; i + 1 < count; i++) {
            const qx = t.a * points[base + i * 2 + 2] + t.c * points[base + i * 2 + 3] + t.e;
            const qy = t.b * points[base + i * 2 + 2] + t.d * points[base + i * 2 + 3] + t.f;
            for (let k = 0; k < 3; k++) {
              out[o] = k === 0 ? fx : k === 1 ? px : qx;
              out[o + 1] = k === 0 ? fy : k === 1 ? py : qy;
              out[o + 2] = 0;
              out[o + 3] = 0;
              packed[o + COLOR_WORD] = rgba;
              out[o + EDGE_WORD] = -1;
              o += WORDS_PER_VERTEX;
            }
            px = qx;
            py = qy;
          }
          vertexCount = vertexCount + total;
          continue;
        }
        // Concave subpaths are rare; ear clipping works on a plain copy of their points.
        const flat: number[] = [];
        for (let i = 0; i < count * 2; i++) flat.push(points[base + i]);
        const indices = triangulate(flat);
        if (!useTexture(white.id, indices.length)) return;
        for (const index of indices) vertex(flat[index * 2], flat[index * 2 + 1], 0, 0, state.fill, -1);
      }
    },
    stroke: (): void => {
      for (let s = 0; s < subpathCount; s++) {
        const points = pathData;
        const base = subpathStart(s);
        const count = (subpathEnd(s) - base) / 2;
        for (let i = 0; i + 1 < count; i++) {
          const o = base + i * 2;
          strokeSegment(points[o], points[o + 1], points[o + 2], points[o + 3]);
        }
        if (closed[s] && count > 2) strokeSegment(points[base + count * 2 - 2], points[base + count * 2 - 1], points[base], points[base + 1]);
      }
    },
    drawImageTinted: (
      image: Texture,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
      color: string,
    ): void => {
      if (!useTexture(image.id, 6)) return;
      emitQuad(dx, dy, dx + dw, dy, dx + dw, dy + dh, dx, dy + dh, sx / image.width, sy / image.height, (sx + sw) / image.width, (sy + sh) / image.height, parseColor(color), -2);
    },
    addFont: (families: string[], atlas: Texture, metricsJson: string): void => {
      const metrics = JSON.parse(metricsJson) as FontMetrics;
      const glyphs = new Map<number, Glyph>();
      for (const glyph of metrics.glyphs) glyphs.set(glyph.code, glyph);
      const font: Font = { atlas, metrics, glyphs };
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
    drawImage: (
      image: Texture,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void => {
      if (!useTexture(image.id, 6)) return;
      const u0 = sx / image.width;
      const v0 = sy / image.height;
      const u1 = (sx + sw) / image.width;
      const v1 = (sy + sh) / image.height;
      emitQuad(dx, dy, dx + dw, dy, dx + dw, dy + dh, dx, dy + dh, u0, v0, u1, v1, WHITE, -1);
    },
  };
}
