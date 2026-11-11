// Bundle the MIT-licensed Bryntum Scheduler Community edition into one file the console serves
// itself (no CDN at runtime). Run: pnpm --filter @certifier/api build:vendor
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public");
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("@bryntum/scheduler-community/package.json"));

mkdirSync(out, { recursive: true });
await build({
  stdin: { contents: 'import { Scheduler } from "@bryntum/scheduler-community"; window.BryntumScheduler = Scheduler;', resolveDir: here, loader: "js" },
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  legalComments: "eof",
  outfile: join(out, "bryntum-scheduler.js"),
});
copyFileSync(join(pkgDir, "scheduler.css"), join(out, "bryntum-scheduler.css"));
copyFileSync(join(pkgDir, "stockholm-light.css"), join(out, "bryntum-theme.css"));
copyFileSync(join(pkgDir, "LICENSE"), join(out, "bryntum-LICENSE.txt"));
console.log("built public/bryntum-scheduler.js, bryntum-scheduler.css, bryntum-theme.css (MIT)");
