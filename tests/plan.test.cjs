/** Таблица решений трёхстороннего сравнения, политики конфликтов, пути. */
const { buildPlan } = require("./.build/sync.js");
const { PathFilter, remoteJoin, remoteToRelative, splitExt } = require("./.build/util.js");
const { makeAsserter } = require("./fakes.cjs");

const { state, eq } = makeAsserter();

const L = (md5, mtime = 1000) => new Map([["n.md", { rel: "n.md", path: "n.md", md5, size: 10, mtime }]]);
const R = (md5, modified = 1000) => new Map([["n.md", { rel: "n.md", md5, size: 10, modified }]]);
const EMPTY = new Map();
const snap = (md5) => (md5 ? { "n.md": { md5, size: 10, mtime: 1000 } } : {});

const plan = (l, r, s, policy = "keep-both") => {
  const action = buildPlan(l, r, s, policy).find((x) => x.rel === "n.md");
  return action ? action.kind : "(нет)";
};

// Изменения ровно с одной стороны — направление однозначно
eq(plan(L("a"), EMPTY, snap()), "upload", "создан только локально");
eq(plan(EMPTY, R("a"), snap()), "download", "создан только на Диске");
eq(plan(L("a"), R("a"), snap("a")), "record", "обе стороны без изменений");
eq(plan(L("b"), R("a"), snap("a")), "upload", "изменён локально");
eq(plan(L("a"), R("b"), snap("a")), "download", "изменён на Диске");
eq(plan(EMPTY, R("a"), snap("a")), "delete-remote", "удалён локально");
eq(plan(L("a"), EMPTY, snap("a")), "delete-local", "удалён на Диске");

// Содержимое совпало — передавать нечего
eq(plan(L("a"), R("a"), snap()), "record", "созданы одинаковыми с двух сторон");
eq(plan(L("b"), R("b"), snap("a")), "record", "изменены одинаково с двух сторон");
eq(plan(EMPTY, EMPTY, snap("a")), "record", "удалён с обеих сторон");
eq(plan(EMPTY, EMPTY, snap()), "(нет)", "нигде нет — действий нет");

// Удаление против правки: правка побеждает, файл воскресает
eq(plan(L("b"), EMPTY, snap("a")), "upload", "изменён локально, удалён на Диске");
eq(plan(EMPTY, R("b"), snap("a")), "download", "удалён локально, изменён на Диске");

// Конфликты и политики
eq(plan(L("b"), R("c"), snap("a")), "conflict", "конфликт: сохранять обе версии");
eq(plan(L("b"), R("c"), snap("a"), "local-wins"), "upload", "конфликт: локальная побеждает");
eq(plan(L("b"), R("c"), snap("a"), "remote-wins"), "download", "конфликт: версия с Диска побеждает");
eq(plan(L("b"), R("c"), snap()), "conflict", "оба созданы разными");
eq(plan(L("b", 5000), R("c", 1000), snap("a"), "newest-wins"), "upload", "свежее локально");
eq(plan(L("b", 1000), R("c", 5000), snap("a"), "newest-wins"), "download", "свежее на Диске");

// Ни одна комбинация состояний не должна остаться неразобранной
for (const l of [EMPTY, L("a"), L("b")]) {
  for (const r of [EMPTY, R("a"), R("b"), R("c")]) {
    for (const s of [snap(), snap("a")]) {
      eq(plan(l, r, s) === "skip", false, "в матрице состояний нет неразобранных случаев");
    }
  }
}

// Исключения
const f = new PathFilter([".obsidian", ".trash", "**/.DS_Store", "Архив/*.pdf", "Моя папка"]);
eq(f.isExcluded(".obsidian/plugins/x/data.json"), true, "исключается всё поддерево .obsidian");
eq(f.isExcluded(".obsidian"), true, "исключается сама папка .obsidian");
eq(f.isExcluded("заметки/.DS_Store"), true, "шаблон с **");
eq(f.isExcluded("Архив/скан.pdf"), true, "* внутри сегмента");
eq(f.isExcluded("Архив/скан.md"), false, "другое расширение не исключается");
eq(f.isExcluded("Моя папка/файл.md"), true, "пробел в имени папки не ломает шаблон");
eq(f.isExcluded("заметки/идея.md"), false, "обычная заметка проходит");
eq(f.isExcluded("obsidian-заметки/x.md"), false, "частичное совпадение имени не считается");

// Разбор путей
eq(remoteJoin("/Obsidian", "заметки/и.md"), "/Obsidian/заметки/и.md", "склейка пути");
eq(remoteJoin("/Obsidian/", "/a.md"), "/Obsidian/a.md", "лишние слэши схлопываются");
eq(remoteToRelative("/Obsidian", "disk:/Obsidian/заметки/и.md"), "заметки/и.md", "снятие префикса disk:");
eq(remoteToRelative("/Obsidian", "disk:/Другое/и.md"), null, "чужая ветка отбрасывается");
eq(splitExt("фото.tar.gz"), ["фото.tar", ".gz"], "составное расширение");
eq(splitExt(".gitignore"), [".gitignore", ""], "ведущая точка не считается расширением");

console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
process.exit(state.fail ? 1 : 0);
