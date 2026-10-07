// Builds the web target into dist/web with a content-hashed bundle (main.<hash>.js) and a never-cached
// index.html, so browsers and Discord's proxy never run a stale build.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { slimAssets } from "dotframe/cli/slim";

const out = "dist/web";
// Keep .vercel: it links this folder to its project, and without it the next deploy links the repo instead.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) if (entry !== ".vercel") rmSync(`${out}/${entry}`, { recursive: true, force: true });
const built = await Bun.build({ entrypoints: ["main.web.ts"], target: "browser", minify: true, naming: "main.[hash].[ext]", outdir: out });
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const bundle = built.outputs[0].path.split("/").pop() ?? "main.js";
const html = await Bun.file("index.html").text();
writeFileSync(`${out}/index.html`, html.replace("./main.js", `./${bundle}`));
writeFileSync(
  `${out}/vercel.json`,
  `${JSON.stringify({ headers: [{ source: "/index.html", headers: [{ key: "Cache-Control", value: "no-cache" }] }, { source: "/", headers: [{ key: "Cache-Control", value: "no-cache" }] }] }, null, 2)}\n`,
);
// Ship-size assets: GLBs keep what the loader reads and opaque PNG textures become JPEG (dotframe assets slim).
if (existsSync("assets")) slimAssets("assets", `${out}/assets`);
console.log(`${out}/${bundle}`);
