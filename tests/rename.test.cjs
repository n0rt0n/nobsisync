/**
 * Переименования. Отдельного отслеживания нет — для плагина это удаление плюс
 * создание, поэтому важно убедиться, что два устройства всё равно сходятся
 * к одному состоянию и дубликат не появляется.
 */
const { SyncEngine } = require("./.build/sync.js");
const { md5hex, makeAdapter, makeClient, makeAsserter, baseSettings } = require("./fakes.cjs");

const { state, eq } = makeAsserter();
const names = (adapter) => [...adapter.files.keys()].sort();
const text = (adapter, p) => adapter.files.get(p)?.data.toString("utf8");

const X = Buffer.from("исходный текст", "utf8");

/** Общее начальное состояние: заметка синхронизирована на оба устройства. */
function setup() {
  const client = makeClient({ "/Obsidian/note.md": X });
  const snap = () => ({ "note.md": { md5: md5hex(X), size: X.length, mtime: 1 } });
  const A = makeAdapter({ "note.md": { data: X, mtime: 1 } });
  const B = makeAdapter({ "note.md": { data: X, mtime: 1 } });
  const sA = { ...baseSettings(), snapshot: snap() };
  const sB = { ...baseSettings(), snapshot: snap() };
  const sync = (adapter, settings) => new SyncEngine({ adapter }, client, settings).run(() => {});
  return { client, A, B, sA, sB, sync };
}

(async () => {
  // Обычное переименование на одном устройстве
  {
    const { client, A, B, sA, sB, sync } = setup();
    await A.rename("note.md", "idea.md");

    const rA = await sync(A, sA);
    eq(rA.errors, [], "синхронизация A без ошибок");
    eq(rA.uploaded, 1, "новое имя выгружено");
    eq(rA.deletedRemote, 1, "старое имя удалено с Диска");
    eq([...client.remote.keys()], ["/Obsidian/idea.md"], "на Диске только новое имя");

    const rB = await sync(B, sB);
    eq(rB.errors, [], "синхронизация B без ошибок");
    eq(names(B), ["idea.md"], "на B осталось только новое имя — дубликата нет");
    eq(B.trashed, ["note.md"], "старое имя ушло в корзину, а не стёрлось");
    eq(text(B, "idea.md"), "исходный текст", "содержимое доехало целым");
  }

  // Переименование против несинхронизированной правки на другом устройстве
  {
    const { A, B, sA, sB, sync } = setup();
    await A.rename("note.md", "idea.md");
    B.files.set("note.md", { data: Buffer.from("правка на устройстве B", "utf8"), mtime: 77 });

    await sync(A, sA);
    const rB = await sync(B, sB);
    eq(rB.errors, [], "синхронизация B без ошибок");
    eq(names(B), ["idea.md", "note.md"], "на B обе заметки — правка не потеряна");
    eq(text(B, "note.md"), "правка на устройстве B", "правка сохранена как есть");

    const rA2 = await sync(A, sA);
    eq(rA2.errors, [], "повторная синхронизация A без ошибок");
    eq(names(A), ["idea.md", "note.md"], "устройства сошлись к одному состоянию");
    eq(text(A, "note.md"), "правка на устройстве B", "правка доехала до A");
  }

  // Переименование папки — то же самое, но для нескольких файлов сразу
  {
    const client = makeClient({ "/Obsidian/Старая/а.md": X, "/Obsidian/Старая/б.md": X });
    const A = makeAdapter({
      "Старая/а.md": { data: X, mtime: 1 },
      "Старая/б.md": { data: X, mtime: 1 },
    });
    const settings = { ...baseSettings(), snapshot: {
      "Старая/а.md": { md5: md5hex(X), size: X.length, mtime: 1 },
      "Старая/б.md": { md5: md5hex(X), size: X.length, mtime: 1 },
    } };
    await A.rename("Старая/а.md", "Новая/а.md");
    await A.rename("Старая/б.md", "Новая/б.md");

    const r = await new SyncEngine({ adapter: A }, client, settings).run(() => {});
    eq(r.errors, [], "переименование папки без ошибок");
    eq(
      [...client.remote.keys()].sort(),
      ["/Obsidian/Новая/а.md", "/Obsidian/Новая/б.md"],
      "на Диске осталась только новая папка"
    );
  }

  console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
  process.exit(state.fail ? 1 : 0);
})();
