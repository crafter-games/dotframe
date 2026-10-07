// A box-filtered mip chain of RGBA8 pixels, level 0 first. Matches the native backend's df_texture mode 2.
export interface MipLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

export function mipChain(width: number, height: number, rgba: Uint8Array): MipLevel[] {
  const levels: MipLevel[] = [{ width, height, data: rgba }];
  let w = width;
  let h = height;
  let level = rgba;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(y * 2, h - 1);
      const y1 = Math.min(y * 2 + 1, h - 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, w - 1);
        const x1 = Math.min(x * 2 + 1, w - 1);
        for (let c = 0; c < 4; c++) {
          const sum = level[(y0 * w + x0) * 4 + c] + level[(y0 * w + x1) * 4 + c] + level[(y1 * w + x0) * 4 + c] + level[(y1 * w + x1) * 4 + c];
          next[(y * nw + x) * 4 + c] = (sum + 2) >> 2;
        }
      }
    }
    levels.push({ width: nw, height: nh, data: next });
    w = nw;
    h = nh;
    level = next;
  }
  return levels;
}
