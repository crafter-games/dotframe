import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, type Ctx, print } from "../lib";
import { slimAssets } from "../slim";

export function assetsSlim(ctx: Ctx, src: string | undefined, out: string | undefined, jpeg: boolean, clips?: string[]): void {
  if (!src || !out) throw new CliError("USAGE", "assets slim needs a source and an output folder", "dotframe assets slim assets dist/web/assets", "core");
  if (!existsSync(src)) throw new CliError("NOT_FOUND", `no folder at ${src}`, "pass the game's assets folder", "core");
  if (resolve(src) === resolve(out)) throw new CliError("USAGE", "the output folder must differ from the source", "write to the build output, for example dist/web/assets", "core");
  const report = slimAssets(src, out, { jpeg, clips });
  const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
  print(ctx, report, () =>
    [
      ...report.files.map((f) => `${f.path}  ${mb(f.before)} -> ${mb(f.after)}${f.note ? `  (${f.note})` : ""}`),
      `${src} ${mb(report.before)} -> ${out} ${mb(report.after)}${report.jpeg ? "" : "  (no ffmpeg or --no-jpeg: PNG textures kept)"}`,
    ].join("\n"),
  );
}
