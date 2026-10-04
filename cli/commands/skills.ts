import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, type Ctx, print } from "../lib";

// Skills ship inside the dotframe package, so the guide always matches the installed CLI.
export function skillsDir(): string {
  return resolve(process.env.DOTFRAME_SKILLS_DIR ?? join(import.meta.dir, "../../skill-data"));
}

interface Skill {
  name: string;
  description: string;
  path: string;
}

function frontmatter(text: string, key: string): string {
  return text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
}

function all(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) throw new CliError("SKILLS_MISSING", `skills directory ${dir} not found`, "reinstall dotframe or unset DOTFRAME_SKILLS_DIR");
  return readdirSync(dir)
    .filter((n: string): boolean => existsSync(join(dir, n, "SKILL.md")))
    .sort((a: string, b: string): number => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)))
    .map((name: string): Skill => {
      const text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
      return { name, description: frontmatter(text, "description"), path: join(dir, name) };
    });
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n: string): string[] => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])).sort();
}

function content(skill: Skill, full: boolean): string {
  const parts = [readFileSync(join(skill.path, "SKILL.md"), "utf8").trim()];
  if (full) {
    for (const sub of ["references", "templates"]) {
      for (const f of files(join(skill.path, sub))) parts.push(`--- ${f.slice(skill.path.length + 1)} ---\n${readFileSync(f, "utf8").trim()}`);
    }
  }
  return parts.join("\n\n");
}

export async function skills(ctx: Ctx, args: string[], full: boolean, everything: boolean): Promise<void> {
  const [op = "list", ...names] = args;
  const list = all();
  const find = (name: string): Skill => {
    const s = list.find((k: Skill): boolean => k.name === name);
    if (!s) throw new CliError("UNKNOWN_SKILL", `no skill named "${name}"`, `available: ${list.map((k: Skill): string => k.name).join(", ")}`);
    return s;
  };
  if (op === "list") {
    const width = Math.max(...list.map((s: Skill): number => s.name.length)) + 2;
    print(ctx, list.map(({ name, description }) => ({ name, description })), (): string => list.map((s: Skill): string => `${s.name.padEnd(width)}${s.description}`).join("\n"));
  } else if (op === "get") {
    if (!everything && names.length === 0) throw new CliError("MISSING_ARG", "skills get needs a name or --all", "dotframe skills get core");
    const chosen = everything ? list : names.map(find);
    print(ctx, chosen.map((s: Skill) => ({ name: s.name, content: content(s, full || everything) })), (): string => chosen.map((s: Skill): string => content(s, full || everything)).join("\n\n"));
  } else if (op === "path") {
    const path = names[0] ? find(names[0]).path : skillsDir();
    print(ctx, { path }, (): string => path);
  } else throw new CliError("UNKNOWN_COMMAND", `skills ${op}`, "dotframe skills list | get <name> | path");
}
