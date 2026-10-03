import { expect, test } from "bun:test";
import { addColorStop, createLinearGradient, createRaster, createRaster2D } from "../src/raster2d";

const pixel = (raster: { width: number; pixels: Uint8Array }, x: number, y: number): number[] => {
  const i = (y * raster.width + x) * 4;
  return [raster.pixels[i], raster.pixels[i + 1], raster.pixels[i + 2], raster.pixels[i + 3]];
};

test("fillRect writes opaque pixels inside the rect only", () => {
  const raster = createRaster(8, 8);
  const ctx = createRaster2D(raster);
  ctx.setFillStyle("#ff0000");
  ctx.fillRect(2, 2, 3, 3);
  expect(pixel(raster, 2, 2)).toEqual([255, 0, 0, 255]);
  expect(pixel(raster, 4, 4)).toEqual([255, 0, 0, 255]);
  expect(pixel(raster, 5, 5)).toEqual([0, 0, 0, 0]);
});

test("translucent fills blend source-over", () => {
  const raster = createRaster(2, 1);
  const ctx = createRaster2D(raster);
  ctx.setFillStyle("#000000");
  ctx.fillRect(0, 0, 2, 1);
  ctx.setFillStyle("rgba(255, 255, 255, 0.5)");
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel(raster, 0, 0);
  expect(r).toBeCloseTo(127, -1);
  expect(g).toBe(r);
  expect(b).toBe(r);
  expect(a).toBe(255);
});

test("vertical linear gradient interpolates between stops", () => {
  const raster = createRaster(1, 11);
  const ctx = createRaster2D(raster);
  const gradient = createLinearGradient(0, 0, 0, 11);
  addColorStop(gradient, 0, "#000000");
  addColorStop(gradient, 1, "#ffffff");
  ctx.setFillGradient(gradient);
  ctx.fillRect(0, 0, 1, 11);
  expect(pixel(raster, 0, 0)[0]).toBeLessThan(20);
  expect(pixel(raster, 0, 5)[0]).toBeCloseTo(128, -1);
  expect(pixel(raster, 0, 10)[0]).toBeGreaterThan(235);
});

test("path fill covers a triangle and leaves the outside empty", () => {
  const raster = createRaster(10, 10);
  const ctx = createRaster2D(raster);
  ctx.setFillStyle("#00ff00");
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(10, 0);
  ctx.lineTo(0, 10);
  ctx.closePath();
  ctx.fill();
  expect(pixel(raster, 1, 1)[1]).toBe(255);
  expect(pixel(raster, 8, 8)[3]).toBe(0);
});

test("a rounded rect made with arcTo has empty corners and a filled middle", () => {
  const raster = createRaster(20, 20);
  const ctx = createRaster2D(raster);
  ctx.setFillStyle("#ffffff");
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(20, 0, 20, 20, r);
  ctx.arcTo(20, 20, 0, 20, r);
  ctx.arcTo(0, 20, 0, 0, r);
  ctx.arcTo(0, 0, 20, 0, r);
  ctx.closePath();
  ctx.fill();
  expect(pixel(raster, 0, 0)[3]).toBe(0);
  expect(pixel(raster, 19, 19)[3]).toBe(0);
  expect(pixel(raster, 10, 10)[3]).toBe(255);
  expect(pixel(raster, 10, 0)[3]).toBe(255);
});

test("drawImage scales with nearest neighbor", () => {
  const source = createRaster(2, 1);
  source.pixels.set([255, 0, 0, 255, 0, 0, 255, 255]);
  const raster = createRaster(4, 2);
  const ctx = createRaster2D(raster);
  ctx.drawImage(source, 0, 0, 2, 1, 0, 0, 4, 2);
  expect(pixel(raster, 1, 1)).toEqual([255, 0, 0, 255]);
  expect(pixel(raster, 2, 0)).toEqual([0, 0, 255, 255]);
});
