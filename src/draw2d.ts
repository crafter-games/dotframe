import { BufferUsage, type Color, type Draw, type Gpu, type Texture, VertexFormat } from "./gpu";

// Immediate-mode 2D drawing modeled on the Canvas2D API, so Canvas2D games port mechanically.
// Coordinates are logical pixels (top-left origin) mapped onto the whole surface.
// State setters replace Canvas2D property assignment: setFillStyle("#fff") for ctx.fillStyle = "#fff".

export interface Draw2D {
  begin: () => void;
  end: (clear: Color) => void;
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
}

@vertex
fn vs_main(@location(0) position: vec2f, @location(1) uv: vec2f, @location(2) color: vec4f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position.x / u.size.x * 2.0 - 1.0, 1.0 - position.y / u.size.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv) * in.color;
}
`;

const FLOATS_PER_VERTEX = 8;
const MAX_VERTICES = 196608;
const CURVE_SEGMENTS = 32;

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
    const channel = (index: number): number => Number(parts[index]?.trim() ?? "0");
    const alpha = parts.length > 3 ? channel(3) : 1;
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

export function createDraw2D(gpu: Gpu, width: number, height: number): Draw2D {
  const pipeline = gpu.createPipeline({
    wgsl: shader,
    stride: FLOATS_PER_VERTEX * 4,
    attributes: [
      { format: VertexFormat.Float32x2, offset: 0, location: 0 },
      { format: VertexFormat.Float32x2, offset: 8, location: 1 },
      { format: VertexFormat.Float32x4, offset: 16, location: 2 },
    ],
    depth: false,
    blend: true,
  });
  const vertices = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
  const vertexBuffer = gpu.createBuffer(BufferUsage.Vertex, new Uint8Array(vertices.byteLength));
  const uniforms = new Float32Array([width, height, 0, 0]);
  const uniformBuffer = gpu.createBuffer(
    BufferUsage.Uniform,
    new Uint8Array(uniforms.buffer, uniforms.byteOffset, uniforms.byteLength),
  );
  const white = gpu.createTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
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
  });
  let state = initialState();
  const stack: State[] = [];
  let vertexCount = 0;
  const batches: Batch[] = [];
  // Current path: subpaths of flat point lists, in path (untransformed) space.
  let subpaths: number[][] = [];
  let closed: boolean[] = [];

  const vertex = (x: number, y: number, u: number, v: number, color: Rgba): void => {
    if (vertexCount >= MAX_VERTICES) return;
    const o = vertexCount * FLOATS_PER_VERTEX;
    vertices[o] = state.a * x + state.c * y + state.e;
    vertices[o + 1] = state.b * x + state.d * y + state.f;
    vertices[o + 2] = u;
    vertices[o + 3] = v;
    vertices[o + 4] = color.r;
    vertices[o + 5] = color.g;
    vertices[o + 6] = color.b;
    vertices[o + 7] = color.a * state.alpha;
    vertexCount++;
  };

  // Reserves room for whole triangles on the given texture, starting a new batch when it changes.
  const useTexture = (texture: number, triangleVertices: number): boolean => {
    if (vertexCount + triangleVertices > MAX_VERTICES) return false;
    const last = batches[batches.length - 1];
    if (last && last.texture === texture) last.count += triangleVertices;
    else batches.push({ texture, first: vertexCount, count: triangleVertices });
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
    vertex(x0, y0, 0, 0, color);
    vertex(x1, y1, 0, 0, color);
    vertex(x2, y2, 0, 0, color);
    vertex(x0, y0, 0, 0, color);
    vertex(x2, y2, 0, 0, color);
    vertex(x3, y3, 0, 0, color);
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

  const currentSubpath = (): number[] => {
    if (subpaths.length === 0) {
      subpaths.push([]);
      closed.push(false);
    }
    return subpaths[subpaths.length - 1];
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
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / full) * CURVE_SEGMENTS));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points = currentSubpath();
    for (let i = 0; i <= steps; i++) {
      const angle = start + (sweep * i) / steps;
      const px = Math.cos(angle) * radiusX;
      const py = Math.sin(angle) * radiusY;
      points.push(x + px * cos - py * sin, y + px * sin + py * cos);
    }
  };

  return {
    begin: (): void => {
      vertexCount = 0;
      batches.length = 0;
      state = initialState();
      stack.length = 0;
    },
    end: (clear: Color): void => {
      gpu.writeBuffer(vertexBuffer, new Uint8Array(vertices.buffer, 0, vertexCount * FLOATS_PER_VERTEX * 4));
      const draws: Draw[] = [];
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
      subpaths = [];
      closed = [];
    },
    moveTo: (x: number, y: number): void => {
      subpaths.push([x, y]);
      closed.push(false);
    },
    lineTo: (x: number, y: number): void => {
      currentSubpath().push(x, y);
    },
    rect: (x: number, y: number, w: number, h: number): void => {
      subpaths.push([x, y, x + w, y, x + w, y + h, x, y + h]);
      closed.push(true);
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
      if (closed.length > 0) closed[closed.length - 1] = true;
    },
    fill: (): void => {
      for (const points of subpaths) {
        const indices = triangulate(points);
        if (!useTexture(white.id, indices.length)) return;
        for (const index of indices) vertex(points[index * 2], points[index * 2 + 1], 0, 0, state.fill);
      }
    },
    stroke: (): void => {
      for (let s = 0; s < subpaths.length; s++) {
        const points = subpaths[s];
        const count = points.length / 2;
        for (let i = 0; i + 1 < count; i++) {
          strokeSegment(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3]);
        }
        if (closed[s] && count > 2) strokeSegment(points[count * 2 - 2], points[count * 2 - 1], points[0], points[1]);
      }
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
      const tint: Rgba = { r: 1, g: 1, b: 1, a: 1 };
      vertex(dx, dy, u0, v0, tint);
      vertex(dx + dw, dy, u1, v0, tint);
      vertex(dx + dw, dy + dh, u1, v1, tint);
      vertex(dx, dy, u0, v0, tint);
      vertex(dx + dw, dy + dh, u1, v1, tint);
      vertex(dx, dy + dh, u0, v1, tint);
    },
  };
}
