import { createDraw2D } from "../../src/draw2d";
import type { Frame, Gpu, Setup, Texture } from "../../src/gpu";
import type { Input } from "../../src/input";

export const windowOptions = { width: 800, height: 450, title: "dotframe: canvas2d" };
export const assetPath = "assets/crafter.png";

// Exercises the Canvas2D-style layer: transforms, alpha, concave paths, arcs, strokes and sprites.
export function createSetup(png: Uint8Array): Setup {
  return (gpu: Gpu, _input: Input): Frame => {
    const ctx = createDraw2D(gpu, windowOptions.width, windowOptions.height);
    let sprite: Texture | null = null;
    gpu.createImage(png).then((texture: Texture): void => {
      sprite = texture;
    });

    return (_gpu: Gpu, time: number): boolean => {
      ctx.begin();

      ctx.setFillStyle("#1e293b");
      ctx.fillRect(0, 360, 800, 90);
      ctx.setStrokeStyle("#475569");
      ctx.setLineWidth(2);
      ctx.strokeRect(20, 20, 760, 320);

      ctx.save();
      ctx.translate(140, 180);
      ctx.rotate(time);
      ctx.setFillStyle("#f97316");
      ctx.fillRect(-50, -50, 100, 100);
      ctx.restore();

      ctx.setFillStyle("rgba(59, 130, 246, 0.6)");
      ctx.beginPath();
      ctx.arc(320, 180, 70, 0, Math.PI * 2, false);
      ctx.fill();

      // Concave five-point star.
      ctx.setFillStyle("#facc15");
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 70 : 30;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5 + time * 0.5;
        const x = 520 + Math.cos(angle) * radius;
        const y = 180 + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.setStrokeStyle("#ffffff");
      ctx.setLineWidth(3);
      ctx.stroke();

      ctx.setGlobalAlpha(0.5 + 0.5 * Math.sin(time * 2));
      ctx.setFillStyle("#22c55e");
      ctx.beginPath();
      ctx.ellipse(680, 180, 60, 30, time, 0, Math.PI * 2, false);
      ctx.fill();
      ctx.setGlobalAlpha(1);

      const current = sprite;
      if (current) {
        const frame = Math.floor(time * 4) % 2;
        const x = ((time * 120) % 900) - 50;
        ctx.drawImage(current, frame * 16, 0, 16, 16, x, 296, 64, 64);
      }

      ctx.end({ r: 0.06, g: 0.06, b: 0.1 });
      return true;
    };
  };
}
