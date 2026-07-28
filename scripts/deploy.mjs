/**
 * Копирует собранный плагин в хранилище Obsidian.
 *
 * Запуск:
 *   npm run deploy                      — хранилище определяется автоматически
 *   npm run deploy -- "/путь/к/vault"   — явный путь
 *   OBSIDIAN_VAULT="/путь" npm run deploy
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "fs";
import { homedir, platform } from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "nobsisync";
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

function die(message, hint) {
  console.error(`Ошибка: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/** Путь к списку хранилищ Obsidian — он разный на каждой платформе. */
function obsidianConfigPath() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "obsidian", "obsidian.json");
  }
}

/** Берём открытое сейчас хранилище, иначе то, что открывали последним. */
function detectVault() {
  const config = obsidianConfigPath();
  if (!existsSync(config)) return null;

  let vaults;
  try {
    vaults = Object.values(JSON.parse(readFileSync(config, "utf8")).vaults ?? {});
  } catch {
    return null;
  }

  const usable = vaults.filter((v) => v.path && existsSync(v.path));
  if (usable.length === 0) return null;

  const open = usable.find((v) => v.open);
  if (open) return open.path;

  return usable.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0].path;
}

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT ?? detectVault();

if (!vault) {
  die(
    "не удалось определить хранилище Obsidian",
    'укажите путь явно: npm run deploy -- "/путь/к/хранилищу"'
  );
}
if (!existsSync(path.join(vault, ".obsidian"))) {
  die(`в «${vault}» нет папки .obsidian`, "это точно хранилище Obsidian?");
}

for (const file of ARTIFACTS) {
  if (!existsSync(path.join(root, file))) {
    die(`нет собранного файла ${file}`, "сначала выполните npm run build");
  }
}

const target = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);

// Симлинк, оставшийся от прежнего способа установки, молча перезаписывать нельзя:
// копирование пошло бы по ссылке обратно в репозиторий.
if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
  die(
    `${target} — символическая ссылка, а не папка`,
    "удалите её вручную, затем повторите: rm " + JSON.stringify(target)
  );
}

mkdirSync(target, { recursive: true });
for (const file of ARTIFACTS) {
  copyFileSync(path.join(root, file), path.join(target, file));
}

console.log(`Плагин скопирован в:\n  ${target}`);
console.log(`Файлы: ${ARTIFACTS.join(", ")}`);
console.log("\nВ Obsidian: Cmd+P → «Reload app without saving», затем включите плагин в настройках.");
