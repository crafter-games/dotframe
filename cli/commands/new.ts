import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, print, runSteps, target } from "../lib";

const TEMPLATES = resolve(import.meta.dir, "../../templates");
const STUB = `---
name: dotframe
description: Build, test, and export this dotframe game. Use when changing gameplay, simulating or replaying frames, checking a render, debugging netplay desyncs, or building and deploying a target.
---
Run \`dotframe skills get core\` before any dotframe command. It matches the installed CLI version.
List the specialized guides with \`dotframe skills list\`.
`;

export async function create(ctx: Ctx, name: string | undefined, template: string): Promise<void> {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new CliError("BAD_NAME", "new needs a lowercase name (letters, digits, dashes)", "dotframe new my-game --template fighter", "game-design");
  const templates = readdirSync(TEMPLATES).filter((t: string): boolean => !t.startsWith("_"));
  if (!templates.includes(template)) throw new CliError("UNKNOWN_TEMPLATE", `no template "${template}"`, `available: ${templates.join(", ")}`, "game-design");
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) throw new CliError("EXISTS", `${dir} already exists`, "pick another name or delete it", "game-design");
  const files: [string, string][] = [
    ...readdirSync(join(TEMPLATES, "_base")).map((f: string): [string, string] => [join(TEMPLATES, "_base", f), f === "gitignore" ? ".gitignore" : f]),
    [join(TEMPLATES, template, "game.ts"), "src/game.ts"],
  ];
  if (ctx.dryRun) {
    print(ctx, { dryRun: true, dir, template, files: files.map(([, to]) => to) }, (): string => `would create ${dir} (${template}): ${files.map(([, to]) => to).join(", ")}`);
    return;
  }
  for (const [from, to] of files) {
    mkdirSync(join(dir, to, ".."), { recursive: true });
    writeFileSync(join(dir, to), readFileSync(from, "utf8").replaceAll("__NAME__", name).replaceAll("__SCOPE__", "your-vercel-team"));
  }
  mkdirSync(join(dir, ".agents/skills/dotframe"), { recursive: true });
  writeFileSync(join(dir, ".agents/skills/dotframe/SKILL.md"), STUB);
  mkdirSync(join(dir, "replays"), { recursive: true });
  const steps = [
    { label: "git init", argv: ["git", "init", "-q"] },
    { label: "install", argv: ["bun", "install"] },
  ];
  for (const step of steps) {
    const r = await exec(ctx, dir, step);
    if (r.code !== 0) throw new CliError("STEP_FAILED", `${step.label}: ${r.tail}`, "on a machine with a private registry, run bun install --registry https://registry.npmjs.org", "game-design");
  }
  print(ctx, { dir, template, next: [`cd ${name}`, "dotframe sim --mash 7 --json", "dotframe dev"] }, (): string => `created ${dir} (${template})\nnext: cd ${name} && dotframe sim --mash 7 && dotframe dev`);
}

// Builds the web target, serves it, and rebuilds when source changes. For humans; agents use sim and snap.
export async function dev(ctx: Ctx, port: number): Promise<void> {
  const config = loadConfig();
  const t = target(config, "web");
  if (!t.out) throw new CliError("NO_OUT", "the web target needs an out dir", "", "export-web");
  const out = resolve(config.root, t.out);
  await runSteps(ctx, config.root, t.steps, "export-web");
  const server = Bun.serve({
    port,
    fetch: (req: Request): Response => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      return new Response(Bun.file(join(out, path === "/" ? "index.html" : path)));
    },
  });
  console.error(`serving ${out} at http://localhost:${server.port}`);
  let pending: ReturnType<typeof setTimeout> | null = null;
  watch(config.root, { recursive: true }, (_event, file): void => {
    if (!file || /(^|\/)(node_modules|dist|\.dotframe|\.git)\//.test(`${file}/`) || file.startsWith(t.out ?? "dist")) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout((): void => {
      runSteps(ctx, config.root, t.steps, "export-web").then(
        (): void => console.error(`rebuilt (${file})`),
        (e: unknown): void => console.error(e instanceof Error ? e.message : e),
      );
    }, 150);
  });
  await new Promise((): void => {});
}
