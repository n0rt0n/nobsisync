/** Общие для тестов заглушки файловой системы и Яндекс.Диска. */
const crypto = require("crypto");

const md5hex = (buf) => crypto.createHash("md5").update(Buffer.from(buf)).digest("hex");

function missing(p) {
  const e = new Error(`ENOENT: ${JSON.stringify(p)}`);
  e.code = "ENOENT";
  throw e;
}

/**
 * Файловая система с побайтовым сравнением имён — как NTFS и ext4.
 * Именно на такой ФС видно ошибки в работе с нормализацией Unicode:
 * macOS с её поиском без учёта нормализации их бы скрыла.
 */
function makeAdapter(initial) {
  const files = new Map(Object.entries(initial));
  const trashed = [];
  return {
    files,
    trashed,
    async list(dir) {
      const prefix = dir === "/" || dir === "" ? "" : dir.replace(/\/$/, "") + "/";
      const folders = new Set();
      const out = [];
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const i = rest.indexOf("/");
        if (i === -1) out.push(p);
        else folders.add(prefix + rest.slice(0, i));
      }
      return { files: out, folders: [...folders] };
    },
    async stat(p) {
      const f = files.get(p);
      return f ? { type: "file", size: f.data.length, mtime: f.mtime, ctime: f.mtime } : null;
    },
    async readBinary(p) {
      const f = files.get(p) ?? missing(p);
      return f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length);
    },
    async writeBinary(p, data) {
      files.set(p, { data: Buffer.from(data), mtime: 5000 });
    },
    async read(p) {
      return (files.get(p) ?? missing(p)).data.toString("utf8");
    },
    async write(p, text) {
      files.set(p, { data: Buffer.from(text, "utf8"), mtime: 5000 });
    },
    async append(p, text) {
      const cur = files.get(p);
      const next = cur ? Buffer.concat([cur.data, Buffer.from(text, "utf8")]) : Buffer.from(text, "utf8");
      files.set(p, { data: next, mtime: 5000 });
    },
    async exists(p) {
      return files.has(p);
    },
    async mkdir() {},
    async remove(p) {
      files.delete(p);
    },
    async trashLocal(p) {
      if (!files.has(p)) missing(p);
      trashed.push(p);
      files.delete(p);
    },
    async rename(from, to) {
      const f = files.get(from) ?? missing(from);
      files.delete(from);
      files.set(to, f);
    },
  };
}

/** Клиент Диска в памяти. calls хранит историю вызовов для проверки путей. */
function makeClient(initial) {
  const remote = new Map(Object.entries(initial));
  const calls = [];
  return {
    remote,
    calls,
    requestCount: 0,
    resetRunState() { this.requestCount = 0; },
    async listVault(base) {
      return [...remote.entries()].map(([abs, data]) => ({
        rel: abs.slice(base.length + 1),
        md5: md5hex(data),
        size: data.length,
        modified: 1000,
      }));
    },
    async download(abs) {
      calls.push(["download", abs]);
      const d = remote.get(abs);
      if (!d) throw new Error(`404 ${abs}`);
      return d.buffer.slice(d.byteOffset, d.byteOffset + d.length);
    },
    async upload(abs, data) {
      calls.push(["upload", abs]);
      remote.set(abs, Buffer.from(data));
    },
    async remove(abs) {
      calls.push(["remove", abs]);
      remote.delete(abs);
    },
  };
}

/** Минимальный набор проверок, чтобы не тащить тестовый фреймворк. */
function makeAsserter() {
  const state = { total: 0, fail: 0 };
  const eq = (got, want, label) => {
    state.total++;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      state.fail++;
      console.log(`  FAIL ${label}\n    получено  ${JSON.stringify(got)}\n    ожидалось ${JSON.stringify(want)}`);
    }
  };
  return { state, eq };
}

const baseSettings = () => ({
  remoteBase: "/Obsidian",
  conflictPolicy: "keep-both",
  excludePatterns: [".obsidian"],
  maxFileSizeMb: 100,
  concurrency: 1,
  deviceName: "тест",
  trashLocalDeletes: true,
  snapshot: {},
});

module.exports = { md5hex, makeAdapter, makeClient, makeAsserter, baseSettings };
