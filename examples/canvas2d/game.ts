import { createDraw2D } from "../../src/draw2d";
import type { Frame, Setup, Texture } from "../../src/gpu";
import { MouseButton } from "../../src/input";
import type { Platform } from "../../src/platform";

export const windowOptions = { width: 800, height: 450, title: "dotframe: canvas2d" };
export const assetPaths = {
  sprite: "assets/crafter.png",
  bangersAtlas: "assets/fonts/bangers.png",
  bangersMetrics: "assets/fonts/bangers.json",
  archivoAtlas: "assets/fonts/archivo-black.png",
  archivoMetrics: "assets/fonts/archivo-black.json",
};

export interface Assets {
  sprite: Uint8Array;
  bangersAtlas: Uint8Array;
  bangersMetrics: Uint8Array;
  archivoAtlas: Uint8Array;
  archivoMetrics: Uint8Array;
}

// Exercises the Canvas2D-style layer: transforms, alpha, concave paths, arcs, strokes, sprites and text.
export function createSetup(assets: Assets): Setup {
  return ({ gpu, input, storage }: Platform): Frame => {
    const runs = Number(storage.get("runs") ?? "0") + 1;
    storage.set("runs", `${runs}`);
    const ctx = createDraw2D(gpu, windowOptions.width, windowOptions.height);
    let sprite: Texture | null = null;
    gpu.createImage(assets.sprite, false).then((texture: Texture): void => {
      sprite = texture;
    });
    const decoder = new TextDecoder();
    gpu.createImage(assets.bangersAtlas, true).then((atlas: Texture): void => {
      ctx.addFont(["Bangers"], atlas, decoder.decode(assets.bangersMetrics));
    });
    gpu.createImage(assets.archivoAtlas, true).then((atlas: Texture): void => {
      ctx.addFont(["Archivo Black", "Arial Black", "Impact", "sans-serif", "monospace"], atlas, decoder.decode(assets.archivoMetrics));
    });

    return (time: number): boolean => {
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

      // Text, in the styles Crafter Smash uses for its HUD and menus.
      const pulse = 1 + 0.08 * Math.sin(time * 6);
      ctx.setFont(`${Math.round(72 * pulse)}px Bangers, Impact`);
      ctx.setTextAlign("center");
      ctx.setTextBaseline("middle");
      ctx.setStrokeStyle("#000000");
      ctx.setLineWidth(8);
      ctx.strokeText("¡GO!", 400, 72);
      ctx.setFillStyle("#facc15");
      ctx.fillText("¡GO!", 400, 72);

      ctx.setFont('italic 900 36px "Arial Black", Impact, sans-serif');
      ctx.setTextAlign("left");
      ctx.setTextBaseline("alphabetic");
      const damage = Math.floor((time * 23) % 300);
      ctx.setLineWidth(5);
      ctx.strokeText(`${damage}%`, 40, 420);
      ctx.setFillStyle(damage > 120 ? "#ef4444" : "#ffffff");
      ctx.fillText(`${damage}%`, 40, 420);

      ctx.setFont("bold 14px Menlo, monospace");
      ctx.setTextAlign("right");
      ctx.setFillStyle("#94a3b8");
      ctx.fillText("Railly · Anthony · Jibaru · Shiara · Edward — ñandú, acción", 770, 430);

      ctx.setFont("16px Bangers");
      ctx.setTextAlign("left");
      ctx.setTextBaseline("top");
      ctx.setFillStyle("#94a3b8");
      ctx.fillText(`run #${runs}`, 32, 30);

      const pointer = input.pointer();
      ctx.setFillStyle(pointer.buttons & MouseButton.Left ? "#ef4444" : "#ffffff");
      ctx.beginPath();
      ctx.arc(pointer.x * windowOptions.width, pointer.y * windowOptions.height, 6, 0, Math.PI * 2, false);
      ctx.fill();

      ctx.end({ r: 0.06, g: 0.06, b: 0.1 });
      return true;
    };
  };
}
