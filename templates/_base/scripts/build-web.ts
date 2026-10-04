// Builds the web target into dist/web with a content-hashed bundle (main.<hash>.js) and a never-cached
// index.html, so browsers and Discord's proxy never run a stale build.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const out = "dist/web";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
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
if (existsSync("assets")) cpSync("assets", `${out}/assets`, { recursive: true });
console.log(`${out}/${bundle}`);
