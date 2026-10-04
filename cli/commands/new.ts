import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, exec, loadConfig, print, runSteps, target } from "../lib";

const TEMPLATES = resolve(import.meta.dir, "../../templates");

export async function create(ctx: Ctx, name: string | undefined, template: string, install = true): Promise<void> {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new CliError("BAD_NAME", "new needs a lowercase name (letters, digits, dashes)", "dotframe new my-game --template fighter", "game-design");
  const templates = readdirSync(TEMPLATES).filter((t: string): boolean => !t.startsWith("_"));
  if (!templates.includes(template)) throw new CliError("UNKNOWN_TEMPLATE", `no template "${template}"`, `available: ${templates.join(", ")}`, "game-design");
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) throw new CliError("EXISTS", `${dir} already exists`, "pick another name or delete it", "game-design");
  const files: [string, string][] = [
    ...(readdirSync(join(TEMPLATES, "_base"), { recursive: true }) as string[])
      .filter((f: string): boolean => statSync(join(TEMPLATES, "_base", f)).isFile())
      .map((f: string): [string, string] => [join(TEMPLATES, "_base", f), f === "gitignore" ? ".gitignore" : f]),
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
  cpSync(resolve(import.meta.dir, "../../skills/dotframe/SKILL.md"), join(dir, ".agents/skills/dotframe/SKILL.md"));
  mkdirSync(join(dir, "replays"), { recursive: true });
  // Inside an existing repo (porting a game on a branch), the new folder is part of that repo.
  const insideRepo = (await exec({ ...ctx, json: true }, process.cwd(), { label: "git check", argv: ["git", "rev-parse", "--is-inside-work-tree"] })).code === 0;
  const steps = [
    ...(insideRepo ? [] : [{ label: "git init", argv: ["git", "init", "-q"] }]),
    ...(install ? [{ label: "install", argv: ["bun", "install"] }] : []),
  ];
  for (const step of steps) {
    const r = await exec(ctx, dir, step);
    if (r.code !== 0) {
      // bun's minimum release age hides versions published in the last N seconds, including a fresh dotframe.
      const fix = /minimum.?release.?age|minimumReleaseAge/i.test(r.tail)
        ? `cd ${name} && bun install --minimum-release-age 0`
        : /registry|401|403|ENOTFOUND/i.test(r.tail)
          ? `cd ${name} && bun install --registry https://registry.npmjs.org`
          : `cd ${name} && bun install, then read its output`;
      throw new CliError("STEP_FAILED", `${step.label}: ${r.tail}`, fix, "game-design");
    }
  }
  print(ctx, { dir, template, gitInit: !insideRepo, next: [`cd ${name}`, "dotframe sim --mash 7 --json", "dotframe dev"] }, (): string => `created ${dir} (${template})\nnext: cd ${name} && dotframe sim --mash 7 && dotframe dev`);
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
      const file = join(out, path === "/" ? "index.html" : path);
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      // Same caching as production: the page is never cached, hashed bundles can be.
      const headers = file.endsWith(".html") ? { "Cache-Control": "no-cache" } : undefined;
      return new Response(Bun.file(file), { headers });
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
