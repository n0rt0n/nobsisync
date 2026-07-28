/** Журнал: вытеснение старых записей, форматирование, ротация лог-файла. */
const {
  entryFromReport,
  failedEntry,
  formatEntry,
  MAX_ENTRIES,
  pushEntry,
  summarize,
  SyncLogFile,
} = require("./.build/journal.js");
const { makeAdapter, makeAsserter } = require("./fakes.cjs");

const { state, eq } = makeAsserter();

const report = (over = {}) => ({
  uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0,
  skipped: 0, unchanged: 0, errors: [], changes: [], bytesUp: 0, bytesDown: 0,
  durationMs: 1200, ...over,
});

// История ограничена и упорядочена свежими вперёд
{
  let history = [];
  for (let i = 0; i < MAX_ENTRIES + 20; i++) {
    history = pushEntry(history, failedEntry("тест", 1000 + i, `сбой ${i}`));
  }
  eq(history.length, MAX_ENTRIES, "история обрезана до предела");
  eq(history[0].fatal, `сбой ${MAX_ENTRIES + 19}`, "самая свежая запись первая");
  eq(history[history.length - 1].fatal, "сбой 20", "самые старые вытеснены");
}

// Длинный список изменений обрезается, но потеря отмечается явно
{
  const changes = Array.from({ length: 250 }, (_, i) => ({ kind: "upload", rel: `файл-${i}.md` }));
  const e = entryFromReport(report({ uploaded: 250, changes }), "вручную", 1000);
  eq(e.changes.length, 200, "список изменений обрезан");
  eq(e.changesTruncated, 50, "количество обрезанного зафиксировано");
  eq(formatEntry(e).includes("и ещё 50 изменений"), true, "обрезка видна в тексте записи");
}

// Короткий список не трогаем
{
  const e = entryFromReport(report({ uploaded: 2, changes: [
    { kind: "upload", rel: "а.md" }, { kind: "download", rel: "б.md" },
  ] }), "вручную", 1000);
  eq(e.changesTruncated, undefined, "без обрезки отметки нет");
  eq(e.ok, true, "прогон без ошибок считается успешным");
}

// Сводки
{
  eq(summarize(entryFromReport(report(), "вручную", 1)), "изменений нет", "пустой прогон");
  eq(
    summarize(entryFromReport(report({ uploaded: 3, bytesUp: 2048 }), "вручную", 1)),
    "↑ 3 (2.0 КБ ↑ / 0 Б ↓)",
    "выгрузка с трафиком"
  );
  eq(
    summarize(entryFromReport(report({ errors: [{ rel: "а.md", message: "HTTP 500" }] }), "вручную", 1)),
    "ошибок 1",
    "ошибки попадают в сводку"
  );
  eq(summarize(failedEntry("по расписанию", 1, "токен истёк")), "сбой: токен истёк", "фатальный сбой");
  eq(
    entryFromReport(report({ errors: [{ rel: "а.md", message: "x" }] }), "вручную", 1).ok,
    false,
    "прогон с ошибками не считается успешным"
  );
}

// Ошибки по файлам и причина сбоя попадают в текст записи
{
  const e = entryFromReport(
    report({ uploaded: 1, changes: [{ kind: "upload", rel: "а.md" }], errors: [{ rel: "б.md", message: "HTTP 507" }] }),
    "по расписанию", 1000
  );
  const text = formatEntry(e);
  eq(text.includes("выгружен: а.md"), true, "перенос виден в записи");
  eq(text.includes("ОШИБКА б.md: HTTP 507"), true, "ошибка по файлу видна в записи");
  eq(text.includes("С ОШИБКАМИ"), true, "статус отражён в заголовке");
  eq(formatEntry(failedEntry("вручную", 1000, "нет сети")).includes("ПРИЧИНА: нет сети"), true,
     "причина фатального сбоя видна");
}

(async () => {
  const LOG = ".obsidian/plugins/nobsisync/sync.log";

  // Файл создаётся, затем дописывается
  {
    const adapter = makeAdapter({});
    const log = new SyncLogFile(adapter, LOG);
    await log.append(failedEntry("вручную", 1000, "первый"));
    eq(adapter.files.has(LOG), true, "лог-файл создан");
    await log.append(failedEntry("вручную", 2000, "второй"));
    const text = await log.read();
    eq(text.includes("первый") && text.includes("второй"), true, "записи дописываются, а не затирают друг друга");
  }

  // Разросшийся лог обрезается с головы, свежие записи остаются
  {
    const adapter = makeAdapter({});
    const log = new SyncLogFile(adapter, LOG);
    // 400 КБ мусора — заведомо больше порога в 256 КБ
    await adapter.write(LOG, ("старая строка мусора\n").repeat(20000));
    const before = (await adapter.stat(LOG)).size;
    await log.append(failedEntry("вручную", 3000, "свежая запись"));
    const after = (await adapter.stat(LOG)).size;
    const text = await log.read();
    eq(before > 256 * 1024, true, "исходный лог действительно превышал порог");
    eq(after < before, true, "после ротации файл стал меньше");
    eq(text.startsWith("[лог обрезан"), true, "обрезка помечена в начале файла");
    eq(text.includes("свежая запись"), true, "свежая запись пережила ротацию");
    eq(text.includes("\n\n"), false, "обрезка прошла по границе строки");
  }

  // Очистка удаляет файл и не падает, если его нет
  {
    const adapter = makeAdapter({});
    const log = new SyncLogFile(adapter, LOG);
    await log.append(failedEntry("вручную", 1000, "запись"));
    await log.clear();
    eq(adapter.files.has(LOG), false, "лог-файл удалён");
    await log.clear();
    eq(await log.read(), "", "повторная очистка и чтение отсутствующего файла безопасны");
  }

  // Сбой записи лога не должен ронять синхронизацию
  {
    const adapter = makeAdapter({});
    adapter.write = async () => { throw new Error("диск только для чтения"); };
    const log = new SyncLogFile(adapter, LOG);
    let threw = false;
    const quiet = console.error;
    console.error = () => {}; // сообщение здесь ожидаемо — не засоряем вывод тестов
    try { await log.append(failedEntry("вручную", 1000, "x")); } catch { threw = true; }
    console.error = quiet;
    eq(threw, false, "ошибка записи лога проглочена, а не выброшена наружу");
  }

  console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
  process.exit(state.fail ? 1 : 0);
})();
