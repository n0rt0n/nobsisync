/** Мелкие помощники: пути, глобы, пул задач. */

/**
 * Нормализация в NFC.
 *
 * macOS хранит имена файлов в NFD ("й" = "и" + комбинирующая краткая), Android и
 * Windows — в NFC. Без приведения к общей форме одна и та же заметка выглядит как
 * два разных файла, и синхронизация начинает плодить дубликаты между устройствами.
 */
export function nfc(s: string): string {
  return s.normalize("NFC");
}

/** Убирает ведущие/замыкающие слэши и схлопывает двойные. */
export function trimSlashes(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

/** Абсолютный путь на Диске: "/Obsidian/Vault" + "заметки/idea.md". */
export function remoteJoin(base: string, rel: string): string {
  const b = trimSlashes(base);
  const r = trimSlashes(rel);
  if (!b) return "/" + r;
  return r ? `/${b}/${r}` : `/${b}`;
}

/** "disk:/Obsidian/Vault/заметки/idea.md" -> "заметки/idea.md" */
export function remoteToRelative(base: string, remotePath: string): string | null {
  const clean = trimSlashes(remotePath.replace(/^disk:/, ""));
  const b = trimSlashes(base);
  if (!b) return clean;
  if (clean === b) return "";
  if (!clean.startsWith(b + "/")) return null;
  return clean.slice(b.length + 1);
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Делит имя на основу и расширение: "фото.tar.gz" -> ["фото.tar", ".gz"]. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

// Заполнитель для "**" на время посимвольных замен: NUL в именах файлов
// встретиться не может, в отличие от пробела или подчёркивания.
const DOUBLE_STAR = "\u0000";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(DOUBLE_STAR)
    .join(".*");
  return new RegExp(`^${body}$`);
}

export class PathFilter {
  private matchers: RegExp[];

  constructor(patterns: string[]) {
    this.matchers = patterns
      .map((p) => trimSlashes(p.trim()))
      .filter((p) => p.length > 0)
      .map(globToRegExp);
  }

  /**
   * Путь исключён, если под шаблон подпадает он сам или любой его родитель —
   * так шаблон ".obsidian" отсекает всё поддерево целиком.
   */
  isExcluded(relPath: string): boolean {
    const segments = relPath.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      for (const m of this.matchers) {
        if (m.test(prefix)) return true;
      }
    }
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Прогоняет items через fn, держа не больше limit задач одновременно. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} МБ`;
  return `${(n / 1073741824).toFixed(2)} ГБ`;
}

/** Метка вида "2026-07-28 16-42" для имён конфликтных копий. */
export function timestampLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(
    d.getMinutes()
  )}`;
}
