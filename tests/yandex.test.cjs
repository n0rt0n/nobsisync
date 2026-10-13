/**
 * Клиент Яндекс.Диска на смоделированных ответах API.
 * Главное, что здесь проверяется, — расход запросов: именно он определяет,
 * упрёмся ли мы в лимиты при частой синхронизации.
 */
const { YandexDiskClient, YandexError } = require("./.build/yandex.js");
const { makeAsserter } = require("./fakes.cjs");

const { state, eq } = makeAsserter();

/** Диск в памяти, отвечающий как настоящий REST API. */
function makeDisk(initial = {}) {
  const files = new Map(Object.entries(initial)); // "/Obsidian/а.md" -> Buffer
  const dirs = new Set(["/Obsidian"]);
  const log = [];
  let failNext = []; // очередь искусственных сбоев: [status, ...]

  const json = (body, status = 200) => ({
    status, json: body, text: JSON.stringify(body), headers: {}, arrayBuffer: new ArrayBuffer(0),
  });
  const err = (status, message, headers = {}) => ({
    status, json: { message }, text: message, headers, arrayBuffer: new ArrayBuffer(0),
  });

  const handler = async (opts) => {
    const url = new URL(opts.url);
    const p = url.searchParams.get("path");
    const route = `${opts.method} ${url.pathname}`;
    log.push(route + (p ? ` ${p}` : ""));

    if (failNext.length > 0) return err(failNext.shift(), "искусственный сбой", { "retry-after": "0" });

    // Загрузка/выгрузка по выданным одноразовым ссылкам
    if (url.hostname === "uploader.example") {
      files.set(url.searchParams.get("target"), Buffer.from(opts.body));
      return { status: 201, json: {}, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) };
    }
    if (url.hostname === "downloader.example") {
      const data = files.get(url.searchParams.get("target"));
      if (!data) return err(404, "нет файла");
      return { status: 200, json: {}, text: "", headers: {},
        arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
    }

    if (route === "GET /v1/disk/resources/upload") {
      return json({ href: `https://uploader.example/put?target=${encodeURIComponent(p)}`, method: "PUT" });
    }
    if (route === "GET /v1/disk/resources/download") {
      if (!files.has(p)) return err(404, "нет файла");
      return json({ href: `https://downloader.example/get?target=${encodeURIComponent(p)}`, method: "GET" });
    }
    if (route === "PUT /v1/disk/resources") {
      if (dirs.has(p)) return err(409, "уже существует");
      dirs.add(p);
      return json({}, 201);
    }
    if (route === "DELETE /v1/disk/resources") {
      if (!files.has(p)) return err(404, "нет файла");
      files.delete(p);
      return json({}, 204);
    }
    if (route === "GET /v1/disk/resources") {
      if (!dirs.has(p)) return err(404, "нет папки");
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const items = [];
      for (const d of dirs) {
        if (d !== p && d.startsWith(p + "/") && !d.slice(p.length + 1).includes("/")) {
          items.push({ path: "disk:" + d, type: "dir" });
        }
      }
      for (const [f, data] of files) {
        if (f.startsWith(p + "/") && !f.slice(p.length + 1).includes("/")) {
          items.push({ path: "disk:" + f, type: "file", md5: "hash-" + f, size: data.length,
                       modified: "2026-07-28T12:00:00+00:00" });
        }
      }
      return json({ _embedded: { total: items.length, offset, limit,
                                 items: items.slice(offset, offset + limit) } });
    }
    if (route === "GET /v1/disk") return json({ user: { login: "тест" }, total_space: 10, used_space: 1 });
    return err(404, `неизвестный маршрут ${route}`);
  };

  return { files, dirs, log, handler, failWith: (...s) => { failNext = s; } };
}

const use = (disk) => { globalThis.__nobsisyncRequest = disk.handler; };
const client = () => new YandexDiskClient(() => "тестовый-токен");

(async () => {
  // Обход папок и постраничность
  {
    const disk = makeDisk();
    for (let i = 0; i < 250; i++) disk.files.set(`/Obsidian/файл-${i}.md`, Buffer.from("x"));
    disk.dirs.add("/Obsidian/Calendar");
    disk.files.set("/Obsidian/Calendar/день.md", Buffer.from("y"));
    use(disk);

    const c = client();
    c.resetRunState();
    const list = await c.listVault("/Obsidian");
    eq(list.length, 251, "получены все файлы, включая вложенную папку");
    eq(list.some((f) => f.rel === "Calendar/день.md"), true, "путь вложенного файла относительный");
    // 250 файлов при странице в 200 — две страницы корня плюс одна для Calendar
    eq(c.requestCount, 3, "постраничность не делает лишних запросов");
  }

  // Выгрузка в уже известную папку не создаёт её заново
  {
    const disk = makeDisk();
    disk.dirs.add("/Obsidian/Calendar");
    disk.files.set("/Obsidian/Calendar/старый.md", Buffer.from("y"));
    use(disk);

    const c = client();
    c.resetRunState();
    await c.listVault("/Obsidian");
    const afterList = c.requestCount;

    await c.upload("/Obsidian/Calendar/новый.md", Buffer.from("данные").buffer);
    eq(c.requestCount - afterList, 2, "выгрузка стоит 2 запроса: ссылка и передача");
    eq(disk.log.filter((l) => l.startsWith("PUT /v1/disk/resources ")).length, 0,
       "папку, известную из листинга, повторно не создаём");

    await c.upload("/Obsidian/Calendar/второй.md", Buffer.from("ещё").buffer);
    eq(c.requestCount - afterList, 4, "каждая следующая выгрузка тоже по 2 запроса");
    eq(disk.files.has("/Obsidian/Calendar/второй.md"), true, "файл действительно загружен");
  }

  // Новая папка создаётся один раз, а не на каждый файл
  {
    const disk = makeDisk();
    use(disk);
    const c = client();
    c.resetRunState();
    await c.listVault("/Obsidian");
    const afterList = c.requestCount;

    await c.upload("/Obsidian/Новая/а.md", Buffer.from("1").buffer);
    await c.upload("/Obsidian/Новая/б.md", Buffer.from("2").buffer);
    await c.upload("/Obsidian/Новая/в.md", Buffer.from("3").buffer);

    const created = disk.log.filter((l) => l === "PUT /v1/disk/resources /Obsidian/Новая").length;
    eq(created, 1, "новая папка создаётся ровно один раз на три файла");
    eq(c.requestCount - afterList, 7, "3 выгрузки по 2 запроса плюс одно создание папки");
  }

  // Скачивание: ссылка плюс сама передача
  {
    const disk = makeDisk({ "/Obsidian/а.md": Buffer.from("содержимое") });
    use(disk);
    const c = client();
    c.resetRunState();
    const data = await c.download("/Obsidian/а.md");
    eq(Buffer.from(data).toString("utf8"), "содержимое", "скачано верное содержимое");
    eq(c.requestCount, 2, "скачивание стоит 2 запроса");
  }

  // 429 повторяется, и повторы видны в счётчике
  {
    const disk = makeDisk({ "/Obsidian/а.md": Buffer.from("x") });
    use(disk);
    const c = client();
    c.resetRunState();
    disk.failWith(429);
    const account = await c.checkAccount();
    eq(account.login, "тест", "после повтора запрос удался");
    eq(c.requestCount, 2, "повтор учтён в расходе запросов");
  }

  // 4xx не повторяется: смысла нет, а лимит тратится
  {
    const disk = makeDisk();
    use(disk);
    const c = client();
    c.resetRunState();
    disk.failWith(401, 401, 401, 401, 401);
    let caught = null;
    try { await c.checkAccount(); } catch (e) { caught = e; }
    eq(caught instanceof YandexError, true, "ошибка типизирована");
    eq(caught.isAuthFailure, true, "401 распознан как проблема с токеном");
    eq(c.requestCount, 1, "на 401 повторов нет");
  }

  // Отсутствующая базовая папка создаётся, а не роняет прогон
  {
    const disk = makeDisk();
    disk.dirs.delete("/Obsidian");
    use(disk);
    const c = client();
    c.resetRunState();
    const list = await c.listVault("/Obsidian");
    eq(list, [], "пустой список вместо ошибки");
    eq(disk.dirs.has("/Obsidian"), true, "базовая папка создана");
  }

  // Текст не-JSON ответа (так отвечает downloader Диска) попадает в сообщение
  {
    const disk = makeDisk({ "/Obsidian/a.md": Buffer.from("x") });
    const inner = disk.handler;
    disk.handler = async (opts) => {
      if (new URL(opts.url).hostname === "downloader.example") {
        return { status: 500, json: undefined, text: "file IO failure: no more reliable hosts",
                 headers: { "retry-after": "0" }, arrayBuffer: new ArrayBuffer(0) };
      }
      return inner(opts);
    };
    use(disk);
    const c = client();
    let caught = null;
    try { await c.download("/Obsidian/a.md"); } catch (e) { caught = e; }
    eq(caught.status, 500, "статус сохранён");
    eq(caught.message, "HTTP 500: file IO failure: no more reliable hosts", "текст тела в сообщении");
  }

  // Удаление уже отсутствующего файла не считается ошибкой
  {
    const disk = makeDisk();
    use(disk);
    const c = client();
    let threw = false;
    try { await c.remove("/Obsidian/нет.md"); } catch { threw = true; }
    eq(threw, false, "404 при удалении проглатывается");
  }

  console.log(`  проверок: ${state.total}, провалов: ${state.fail}`);
  process.exit(state.fail ? 1 : 0);
})();
