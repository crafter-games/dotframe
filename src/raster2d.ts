import { parseColor } from "./draw2d";

// CPU canvas for baking art at load time (pixel-art backgrounds, procedural stages, portraits).
// Implements the Canvas2D subset baking code uses, writes straight RGBA8, and renders identically on every target.
// Upload the result with gpu.createTexture(raster.width, raster.height, raster.pixels, false).

export interface Gradient {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: GradientStop[];
}

export interface GradientStop {
  offset: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Raster {
  width: number;
  height: number;
  // Straight (not premultiplied) RGBA8, row-major.
  pixels: Uint8Array;
}

export interface Raster2D {
  raster: Raster;
  setFillStyle: (color: string) => void;
  setFillGradient: (gradient: Gradient) => void;
  setGlobalAlpha: (alpha: number) => void;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  clearRect: (x: number, y: number, width: number, height: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  arc: (x: number, y: number, radius: number, start: number, end: number, counterclockwise: boolean) => void;
  arcTo: (x1: number, y1: number, x2: number, y2: number, radius: number) => void;
  rect: (x: number, y: number, width: number, height: number) => void;
  closePath: () => void;
  // Nonzero winding, pixel centers sampled, no antialiasing (pixel art).
  fill: () => void;
  // Nearest-neighbor copy of a source rectangle, alpha-blended.
  drawImage: (
    source: Raster,
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

export function createRaster(width: number, height: number): Raster {
  return { width, height, pixels: new Uint8Array(width * height * 4) };
}

export function createLinearGradient(x0: number, y0: number, x1: number, y1: number): Gradient {
  return { x0, y0, x1, y1, stops: [] };
}

export function addColorStop(gradient: Gradient, offset: number, color: string): void {
  const c = parseColor(color);
  gradient.stops.push({ offset, r: c.r, g: c.g, b: c.b, a: c.a });
  gradient.stops.sort((a: GradientStop, b: GradientStop): number => a.offset - b.offset);
}

export function createRaster2D(raster: Raster): Raster2D {
  const { width, height, pixels } = raster;
  let fillR = 0;
  let fillG = 0;
  let fillB = 0;
  let fillA = 1;
  let gradient: Gradient | null = null;
  let alpha = 1;
  // Path as subpaths of flat points.
  const subpaths: number[][] = [];
  let subpathCount = 0;
  let penX = 0;
  let penY = 0;

  const startSubpath = (x: number, y: number): number[] => {
    if (subpathCount === subpaths.length) subpaths.push([]);
    const points = subpaths[subpathCount];
    points.length = 0;
    points.push(x, y);
    subpathCount++;
    return points;
  };
  const current = (): number[] => (subpathCount === 0 ? startSubpath(penX, penY) : subpaths[subpathCount - 1]);
  const addPoint = (x: number, y: number): void => {
    current().push(x, y);
    penX = x;
    penY = y;
  };

  // Writes one pixel with source-over blending of the current fill at (x, y).
  const blendFill = (index: number, x: number, y: number): void => {
    let r = fillR;
    let g = fillG;
    let b = fillB;
    let a = fillA;
    const grad = gradient;
    if (grad) {
      const dx = grad.x1 - grad.x0;
      const dy = grad.y1 - grad.y0;
      const lengthSquared = dx * dx + dy * dy;
      let t = lengthSquared > 0 ? ((x + 0.5 - grad.x0) * dx + (y + 0.5 - grad.y0) * dy) / lengthSquared : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const stops = grad.stops;
      if (stops.length > 0) {
        let k = 0;
        while (k + 1 < stops.length && stops[k + 1].offset < t) k++;
        const from = stops[k];
        const to = stops[k + 1 < stops.length ? k + 1 : k];
        const span = to.offset - from.offset;
        const local = span > 0 ? (t - from.offset) / span : 0;
        const u = local < 0 ? 0 : local > 1 ? 1 : local;
        r = from.r + (to.r - from.r) * u;
        g = from.g + (to.g - from.g) * u;
        b = from.b + (to.b - from.b) * u;
        a = from.a + (to.a - from.a) * u;
      }
    }
    blend(index, r * 255, g * 255, b * 255, a * alpha);
  };

  const blend = (index: number, r: number, g: number, b: number, a: number): void => {
    if (a <= 0) return;
    if (a >= 1) {
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 255;
      return;
    }
    const dstA = pixels[index + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    pixels[index] = (r * a + pixels[index] * dstA * (1 - a)) / outA;
    pixels[index + 1] = (g * a + pixels[index + 1] * dstA * (1 - a)) / outA;
    pixels[index + 2] = (b * a + pixels[index + 2] * dstA * (1 - a)) / outA;
    pixels[index + 3] = outA * 255;
  };

  return {
    raster,
    setFillStyle: (color: string): void => {
      const c = parseColor(color);
      fillR = c.r;
      fillG = c.g;
      fillB = c.b;
      fillA = c.a;
      gradient = null;
    },
    setFillGradient: (value: Gradient): void => {
      gradient = value;
    },
    setGlobalAlpha: (value: number): void => {
      alpha = value;
    },
    fillRect: (x: number, y: number, w: number, h: number): void => {
      const x0 = Math.max(0, Math.round(Math.min(x, x + w)));
      const y0 = Math.max(0, Math.round(Math.min(y, y + h)));
      const x1 = Math.min(width, Math.round(Math.max(x, x + w)));
      const y1 = Math.min(height, Math.round(Math.max(y, y + h)));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) blendFill((py * width + px) * 4, px, py);
      }
    },
    clearRect: (x: number, y: number, w: number, h: number): void => {
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w));
      const y1 = Math.min(height, Math.round(y + h));
      // TypedArray.fill has no scriptc lowering yet; clear byte by byte.
      for (let py = y0; py < y1; py++) {
        for (let i = (py * width + x0) * 4; i < (py * width + x1) * 4; i++) pixels[i] = 0;
      }
    },
    beginPath: (): void => {
      subpathCount = 0;
    },
    moveTo: (x: number, y: number): void => {
      startSubpath(x, y);
      penX = x;
      penY = y;
    },
    lineTo: (x: number, y: number): void => addPoint(x, y),
    arc: (x: number, y: number, radius: number, start: number, end: number, counterclockwise: boolean): void => {
      const full = Math.PI * 2;
      let sweep = end - start;
      if (!counterclockwise && sweep < 0) sweep = (sweep % full) + full;
      if (counterclockwise && sweep > 0) sweep = (sweep % full) - full;
      if (Math.abs(end - start) >= full) sweep = counterclockwise ? -full : full;
      const steps = Math.max(4, Math.ceil((Math.abs(sweep) / full) * Math.max(12, radius * 2)));
      for (let i = 0; i <= steps; i++) {
        const angle = start + (sweep * i) / steps;
        addPoint(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
      }
    },
    // Canvas2D arcTo: a line toward (x1, y1) ending in an arc tangent to both segments.
    arcTo: (x1: number, y1: number, x2: number, y2: number, radius: number): void => {
      const x0 = penX;
      const y0 = penY;
      const ax = x0 - x1;
      const ay = y0 - y1;
      const bx = x2 - x1;
      const by = y2 - y1;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      const cross = ax * by - ay * bx;
      if (radius <= 0 || la === 0 || lb === 0 || Math.abs(cross) < 1e-9) {
        addPoint(x1, y1);
        return;
      }
      const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
      const tangent = radius / Math.tan(angle / 2);
      const t0x = x1 + (ax / la) * tangent;
      const t0y = y1 + (ay / la) * tangent;
      const t1x = x1 + (bx / lb) * tangent;
      const t1y = y1 + (by / lb) * tangent;
      // Center lies along the bisector, at radius from both tangent points.
      const bisX = ax / la + bx / lb;
      const bisY = ay / la + by / lb;
      const bisLength = Math.hypot(bisX, bisY);
      const centerDistance = radius / Math.sin(angle / 2);
      const cx = x1 + (bisX / bisLength) * centerDistance;
      const cy = y1 + (bisY / bisLength) * centerDistance;
      addPoint(t0x, t0y);
      const startAngle = Math.atan2(t0y - cy, t0x - cx);
      let endAngle = Math.atan2(t1y - cy, t1x - cx);
      const clockwise = cross < 0;
      if (clockwise && endAngle < startAngle) endAngle += Math.PI * 2;
      if (!clockwise && endAngle > startAngle) endAngle -= Math.PI * 2;
      const steps = Math.max(2, Math.ceil(Math.abs(endAngle - startAngle) * Math.max(2, radius)));
      for (let i = 1; i <= steps; i++) {
        const a = startAngle + ((endAngle - startAngle) * i) / steps;
        addPoint(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      }
    },
    rect: (x: number, y: number, w: number, h: number): void => {
      const points = startSubpath(x, y);
      points.push(x + w, y, x + w, y + h, x, y + h);
      penX = x;
      penY = y;
    },
    closePath: (): void => {
      if (subpathCount > 0) {
        const points = subpaths[subpathCount - 1];
        penX = points[0];
        penY = points[1];
      }
    },
    fill: (): void => {
      let minY = height;
      let maxY = 0;
      for (let s = 0; s < subpathCount; s++) {
        const points = subpaths[s];
        for (let i = 1; i < points.length; i += 2) {
          minY = Math.min(minY, points[i]);
          maxY = Math.max(maxY, points[i]);
        }
      }
      const yStart = Math.max(0, Math.floor(minY));
      const yEnd = Math.min(height - 1, Math.ceil(maxY));
      const crossings: number[] = [];
      const windings: number[] = [];
      for (let py = yStart; py <= yEnd; py++) {
        const sampleY = py + 0.5;
        crossings.length = 0;
        windings.length = 0;
        for (let s = 0; s < subpathCount; s++) {
          const points = subpaths[s];
          const count = points.length / 2;
          for (let i = 0; i < count; i++) {
            const j = (i + 1) % count;
            const ay = points[i * 2 + 1];
            const by = points[j * 2 + 1];
            if (ay === by) continue;
            const up = ay < by;
            const lowY = up ? ay : by;
            const highY = up ? by : ay;
            if (sampleY < lowY || sampleY >= highY) continue;
            const ax = points[i * 2];
            const bx = points[j * 2];
            crossings.push(ax + ((sampleY - ay) / (by - ay)) * (bx - ax));
            windings.push(up ? 1 : -1);
          }
        }
        // Sort crossings with their windings (insertion sort: few edges per scanline).
        for (let i = 1; i < crossings.length; i++) {
          const x = crossings[i];
          const w = windings[i];
          let j = i - 1;
          while (j >= 0 && crossings[j] > x) {
            crossings[j + 1] = crossings[j];
            windings[j + 1] = windings[j];
            j--;
          }
          crossings[j + 1] = x;
          windings[j + 1] = w;
        }
        let winding = 0;
        for (let i = 0; i + 1 < crossings.length; i++) {
          winding += windings[i];
          if (winding === 0) continue;
          const x0 = Math.max(0, Math.ceil(crossings[i] - 0.5));
          const x1 = Math.min(width - 1, Math.ceil(crossings[i + 1] - 0.5) - 1);
          for (let px = x0; px <= x1; px++) blendFill((py * width + px) * 4, px, py);
        }
      }
    },
    drawImage: (
      source: Raster,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void => {
      const x0 = Math.max(0, Math.round(dx));
      const y0 = Math.max(0, Math.round(dy));
      const x1 = Math.min(width, Math.round(dx + dw));
      const y1 = Math.min(height, Math.round(dy + dh));
      const src = source.pixels;
      for (let py = y0; py < y1; py++) {
        const v = Math.floor(sy + ((py + 0.5 - dy) / dh) * sh);
        if (v < 0 || v >= source.height) continue;
        for (let px = x0; px < x1; px++) {
          const u = Math.floor(sx + ((px + 0.5 - dx) / dw) * sw);
          if (u < 0 || u >= source.width) continue;
          const si = (v * source.width + u) * 4;
          blend((py * width + px) * 4, src[si], src[si + 1], src[si + 2], (src[si + 3] / 255) * alpha);
        }
      }
    },
  };
}
