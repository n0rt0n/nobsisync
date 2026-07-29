/**
 * Файлы, изменённые вне Obsidian (KeePass, git, файловый менеджер).
 *
 * Плагин не подписан на события хранилища — он обходит файловую систему сам,
 * поэтому источник правки значения не имеет. Здесь это проверяется явно,
 * заодно на бинарном файле с расширением, которого Obsidian не знает.
 */
const { SyncEngine } = require("./.build/sync.js");
const { md5hex, makeAdapter, makeClient, makeAsserter, baseSettings } = require("./fakes.cjs");

const { state, eq } = makeAsserter();
const run = (adapter, client, settings) => new SyncEngine({ adapter }, client, settings).run(() => {});

const DB = "Пароли/база.kdbx";
const v1 = Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0x01, 0x02]); // сигнатура KDBX
const v2 = Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5, 0xff, 0xee, 0xdd]);

(async () => {
  // Первая синхронизация: бинарный файл с незнакомым расширением выгружается
  {
    const adapter = makeAdapter({ [DB]: { data: v1, mtime: 100 } });
    const client = makeClient({});
    const settings = baseSettings();

    const r = await run(adapter, client, settings);
    eq(r.errors, [], "выгрузка бинарного файла без ошибок");
    eq(r.uploaded, 1, "файл выгружен, хотя Obsidian такое расширение не индексирует");
    eq(client.remote.get(`/Obsidian/${DB}`)?.equals(v1), true, "на Диск ушли те же байты");

    // Правка сторонней программой: содержимое и mtime изменились
    adapter.files.set(DB, { data: v2, mtime: 200 });

    const r2 = await run(adapter, client, settings);
    eq(r2.errors, [], "повторная синхронизация без ошибок");
    eq(r2.uploaded, 1, "внешняя правка замечена и выгружена");
    eq(client.remote.get(`/Obsidian/${DB}`)?.equals(v2), true, "на Диске новая версия");

    // Без правок ничего не передаётся заново
    const r3 = await run(adapter, client, settings);
    eq(r3.uploaded, 0, "неизменившийся файл повторно не выгружается");
  }

  // Правка того же размера, но с другим содержимым и новым mtime
  {
    const a = Buffer.from("одинаковая длина А");
    const b = Buffer.from("одинаковая длина Б");
    eq(a.length, b.length, "подготовка: длины совпадают");

    const adapter = makeAdapter({ [DB]: { data: a, mtime: 100 } });
    const client = makeClient({});
    const settings = baseSettings();
    await run(adapter, client, settings);

    adapter.files.set(DB, { data: b, mtime: 300 });
    const r = await run(adapter, client, settings);
    eq(r.uploaded, 1, "правка при том же размере замечена по изменившемуся mtime");
  }

  // Известное ограничение: если сторонняя программа сохранит и размер, и mtime,
  // файл будет считаться неизменившимся. Фиксируем поведение честно.
  {
    const a = Buffer.from("одинаковая длина А");
    const b = Buffer.from("одинаковая длина Б");
    const adapter = makeAdapter({ [DB]: { data: a, mtime: 100 } });
    const client = makeClient({});
    const settings = baseSettings();
    await run(adapter, client, settings);

    adapter.files.set(DB, { data: b, mtime: 100 }); // mtime не тронут — так делают редкие утилиты
    const r = await run(adapter, client, settings);
    eq(r.uploaded, 0, "при совпадении размера и mtime правка не видна (известное ограничение)");
  }

  // Файлы блокировки KeePass исключаются шаблоном без слэша на любой глубине
  {
    const adapter = makeAdapter({
      [DB]: { data: v1, mtime: 100 },
      "Пароли/база.kdbx.lock": { data: Buffer.from("lock"), mtime: 100 },
      "база.kdbx.lock": { data: Buffer.from("lock"), mtime: 100 },
    });
    const client = makeClient({});
    const settings = baseSettings();
    settings.excludePatterns = [".obsidian", "*.lock"];

    const r = await run(adapter, client, settings);
    eq(r.uploaded, 1, "выгружена только сама база");
    eq([...client.remote.keys()], [`/Obsidian/${DB}`], "файлы блокировки на Диск не попали");
  }

  // Удаление сторонней программой распространяется на Диск
  {
    const adapter = makeAdapter({ [DB]: { data: v1, mtime: 100 } });
    const client = makeClient({});
    const settings = baseSettings();
    await run(adapter, client, settings);

    adapter.files.delete(DB); // файл убрали мимо Obsidian
    const r = await run(adapter, client, settings);
    eq(r.deletedRemote, 1, "внешнее удаление замечено");
    eq([...client.remote.keys()], [], "файл удалён и с Диска");
  }

  // Файл крупнее лимита пропускается, а не роняет прогон
  {
    const adapter = makeAdapter({ [DB]: { data: Buffer.alloc(3 * 1024 * 1024, 7), mtime: 100 } });
    const client = makeClient({});
    const settings = baseSettings();
    settings.maxFileSizeMb = 1;

    const r = await run(adapter, client, settings);
    eq(r.skipped, 1, "крупный файл пропущен");
    eq(r.uploaded, 0, "и не выгружен");
    eq(r.errors, [], "пропуск не считается ошибкой");
  }

  console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
  process.exit(state.fail ? 1 : 0);
})();
