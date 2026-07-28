/**
 * Сборка исходников с заглушкой obsidian и прогон всех тестов.
 * Запуск: npm test
 */
import esbuild from "esbuild";
import { execFileSync } from "child_process";
import { readdirSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const buildDir = path.join(here, ".build");

mkdirSync(buildDir, { recursive: true });

await esbuild.build({
  entryPoints: ["src/sync.ts", "src/util.ts", "src/md5.ts", "src/journal.ts", "src/yandex.ts"].map((p) =>
    path.join(root, p)
  ),
  bundle: true,
  format: "cjs",
  platform: "node",
  outdir: buildDir,
  alias: { obsidian: path.join(here, "obsidian-stub.js") },
  logLevel: "error",
});

const suites = readdirSync(here).filter((f) => f.endsWith(".test.cjs")).sort();
let failed = 0;

for (const suite of suites) {
  console.log(`\n── ${suite}`);
  try {
    const out = execFileSync(process.execPath, [path.join(here, suite)], { encoding: "utf8" });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    process.stdout.write(e.stdout ?? "");
    process.stderr.write(e.stderr ?? "");
  }
}

console.log(failed === 0 ? "\nВсе наборы пройдены" : `\nНаборов с провалами: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
