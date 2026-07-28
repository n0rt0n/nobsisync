/**
 * Поднимает версию в manifest.json и versions.json вслед за package.json.
 * Вызывается автоматически из `npm version <patch|minor|major>`.
 *
 * Три файла обязаны сходиться: BRAT и каталог Obsidian читают manifest.json,
 * versions.json сообщает, какая версия Obsidian нужна для какой версии плагина,
 * а workflow релиза сверяет тег с manifest.json и падает при расхождении.
 */
import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("Запускать через npm version, а не напрямую.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Версия поднята до ${targetVersion} (минимальная версия Obsidian: ${manifest.minAppVersion})`);
