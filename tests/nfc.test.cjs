/**
 * Работа с нормализацией имён на файловой системе с побайтовым сравнением
 * (Windows, Linux). Ключ сопоставления — NFC, обращение к файлу — по реальному
 * имени. Если перепутать одно с другим, файл не читается, а его удаление молча
 * не срабатывает — и заметка возвращается на следующем проходе.
 */
const { SyncEngine } = require("./.build/sync.js");
const { md5hex, makeAdapter, makeClient, makeAsserter, baseSettings } = require("./fakes.cjs");

const { state, eq } = makeAsserter();

// "ёжик.md": ё — это U+0451 в NFC и пара U+0435 U+0308 в NFD
const NFC = "ёжик.md".normalize("NFC");
const NFD = "ёжик.md".normalize("NFD");
if (NFC === NFD) throw new Error("тестовое имя не различается по нормализации");

const run = (adapter, client, settings) => new SyncEngine({ adapter }, client, settings).run(() => {});

(async () => {
  // Локальный файл под NFD-именем, на Диске его нет — должен выгрузиться
  {
    const body = Buffer.from("тело заметки", "utf8");
    const adapter = makeAdapter({ [NFD]: { data: body, mtime: 1 } });
    const client = makeClient({});
    const settings = baseSettings();
    const r = await run(adapter, client, settings);
    eq(r.errors, [], "выгрузка NFD-файла проходит без ошибок");
    eq(r.uploaded, 1, "файл выгружен");
    eq([...client.remote.keys()], [`/Obsidian/${NFC}`], "на Диске каноническое NFC-имя");
    eq(Object.keys(settings.snapshot), [NFC], "ключ снимка в NFC");
  }

  // На Диске NFD-имя, локально пусто — скачать по настоящему имени
  {
    const adapter = makeAdapter({});
    const client = makeClient({ [`/Obsidian/${NFD}`]: Buffer.from("с диска", "utf8") });
    const settings = baseSettings();
    const r = await run(adapter, client, settings);
    eq(r.errors, [], "скачивание NFD-имени проходит без ошибок");
    eq(r.downloaded, 1, "файл скачан");
    eq(
      client.calls.filter((c) => c[0] === "download").map((c) => c[1]),
      [`/Obsidian/${NFD}`],
      "запрос ушёл по настоящему имени с Диска"
    );
    eq([...adapter.files.keys()], [NFC], "локально создано NFC-имя");
  }

  // Файл удалён на Диске, локально лежит под NFD — удалить нужно именно его
  {
    const body = Buffer.from("тело", "utf8");
    const adapter = makeAdapter({ [NFD]: { data: body, mtime: 1 } });
    const client = makeClient({});
    const settings = baseSettings();
    settings.snapshot = { [NFC]: { md5: md5hex(body), size: body.length, mtime: 1 } };
    const r = await run(adapter, client, settings);
    eq(r.errors, [], "локальное удаление проходит без ошибок");
    eq(r.deletedLocal, 1, "удаление засчитано");
    eq(adapter.trashed, [NFD], "в корзину ушёл реальный NFD-файл");
    eq([...adapter.files.keys()], [], "локально файла не осталось");
    eq(Object.keys(settings.snapshot), [], "запись убрана из снимка");
  }

  // Правка локального NFD-файла при таком же имени на Диске — перезапись, не дубликат
  {
    const body = Buffer.from("новая версия", "utf8");
    const old = Buffer.from("старая", "utf8");
    const adapter = makeAdapter({ [NFD]: { data: body, mtime: 9 } });
    const client = makeClient({ [`/Obsidian/${NFD}`]: old });
    const settings = baseSettings();
    settings.snapshot = { [NFC]: { md5: md5hex(old), size: old.length, mtime: 1 } };
    const r = await run(adapter, client, settings);
    eq(r.errors, [], "выгрузка правки проходит без ошибок");
    eq(
      client.calls.filter((c) => c[0] === "upload").map((c) => c[1]),
      [`/Obsidian/${NFD}`],
      "перезаписан существующий файл, дубликат не создан"
    );
    eq([...client.remote.keys()].length, 1, "на Диске по-прежнему один файл");
  }

  console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
  process.exit(state.fail ? 1 : 0);
})();
