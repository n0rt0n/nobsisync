import { DataAdapter } from "obsidian";
import { ActionKind, SyncReport } from "./sync";
import { formatBytes } from "./util";

/**
 * Журнал синхронизаций.
 *
 * История держится в data.json (её показывают настройки и окно журнала), а
 * параллельно пишется текстовый лог в папку плагина. Файл нужен по двум
 * причинам: его можно грепать, и он единственный способ увидеть, что случилось
 * ночью, на телефоне — консоли разработчика там нет.
 */

/** Сколько прогонов держать в истории. Дальше — вытеснение старых. */
export const MAX_ENTRIES = 50;
/** Список изменённых файлов внутри одной записи обрезается, чтобы data.json не распухал. */
const MAX_CHANGES_PER_ENTRY = 200;
/** Порог, после которого лог-файл обрезается с головы. */
const MAX_LOG_BYTES = 256 * 1024;

export interface JournalEntry {
  ts: number;
  trigger: string;
  ok: boolean;
  durationMs: number;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  bytesUp: number;
  bytesDown: number;
  /** Обращений к API Диска за прогон. */
  requests: number;
  errors: { rel: string; message: string }[];
  /** Сообщение ошибки, прервавшей весь прогон (в отличие от ошибок по файлам). */
  fatal?: string;
  changes: { kind: ActionKind; rel: string }[];
  /** Сколько изменений не поместилось в запись. */
  changesTruncated?: number;
}

const ACTION_LABELS: Record<string, string> = {
  upload: "выгружен",
  download: "загружен",
  "delete-local": "удалён локально",
  "delete-remote": "удалён на Диске",
  conflict: "конфликт",
  record: "учтён",
  skip: "пропущен",
};

export function entryFromReport(report: SyncReport, trigger: string, ts: number): JournalEntry {
  const changes = report.changes.slice(0, MAX_CHANGES_PER_ENTRY);
  return {
    ts,
    trigger,
    ok: report.errors.length === 0,
    durationMs: report.durationMs,
    uploaded: report.uploaded,
    downloaded: report.downloaded,
    deletedLocal: report.deletedLocal,
    deletedRemote: report.deletedRemote,
    conflicts: report.conflicts,
    skipped: report.skipped,
    bytesUp: report.bytesUp,
    bytesDown: report.bytesDown,
    requests: report.requests,
    errors: report.errors,
    changes,
    changesTruncated: report.changes.length - changes.length || undefined,
  };
}

export function failedEntry(trigger: string, ts: number, message: string, durationMs = 0): JournalEntry {
  return {
    ts,
    trigger,
    ok: false,
    durationMs,
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    skipped: 0,
    bytesUp: 0,
    bytesDown: 0,
    requests: 0,
    errors: [],
    fatal: message,
    changes: [],
  };
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  return `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`;
}

/** Однострочная сводка прогона — для списка в настройках и заголовка в журнале. */
export function summarize(e: JournalEntry): string {
  if (e.fatal) return `сбой: ${e.fatal}`;

  const parts: string[] = [];
  if (e.uploaded) parts.push(`↑ ${e.uploaded}`);
  if (e.downloaded) parts.push(`↓ ${e.downloaded}`);
  if (e.deletedLocal) parts.push(`удалено локально ${e.deletedLocal}`);
  if (e.deletedRemote) parts.push(`удалено на Диске ${e.deletedRemote}`);
  if (e.conflicts) parts.push(`конфликтов ${e.conflicts}`);
  if (e.skipped) parts.push(`пропущено ${e.skipped}`);
  if (e.errors.length) parts.push(`ошибок ${e.errors.length}`);
  if (parts.length === 0) return "изменений нет";

  const traffic =
    e.bytesUp || e.bytesDown ? ` (${formatBytes(e.bytesUp)} ↑ / ${formatBytes(e.bytesDown)} ↓)` : "";
  return parts.join(", ") + traffic;
}

/** Развёрнутая запись: заголовок, перечень изменений, ошибки. */
export function formatEntry(e: JournalEntry): string {
  const status = e.fatal ? "СБОЙ" : e.errors.length ? "С ОШИБКАМИ" : "успешно";
  const lines = [
    `[${formatTimestamp(e.ts)}] ${e.trigger} · ${status} · ${formatDuration(e.durationMs)}` +
      (e.requests ? ` · запросов к Диску: ${e.requests}` : ""),
    `    ${summarize(e)}`,
  ];

  for (const c of e.changes) {
    lines.push(`    ${ACTION_LABELS[c.kind] ?? c.kind}: ${c.rel}`);
  }
  if (e.changesTruncated) {
    lines.push(`    … и ещё ${e.changesTruncated} изменений (список обрезан)`);
  }
  for (const err of e.errors) {
    lines.push(`    ОШИБКА ${err.rel}: ${err.message}`);
  }
  if (e.fatal) {
    lines.push(`    ПРИЧИНА: ${e.fatal}`);
  }
  return lines.join("\n");
}

export class SyncLogFile {
  constructor(
    private adapter: DataAdapter,
    private path: string
  ) {}

  async append(entry: JournalEntry): Promise<void> {
    const text = formatEntry(entry) + "\n";
    try {
      if (await this.adapter.exists(this.path)) {
        await this.adapter.append(this.path, text);
        await this.rotateIfNeeded();
      } else {
        await this.adapter.write(this.path, text);
      }
    } catch (e) {
      // Журнал не должен ронять синхронизацию: если писать некуда, просто молчим.
      console.error("[NObsiSync] не удалось записать лог-файл", e);
    }
  }

  /** Обрезает файл по границе строки, оставляя свежую половину. */
  private async rotateIfNeeded(): Promise<void> {
    const stat = await this.adapter.stat(this.path);
    if (!stat || stat.size <= MAX_LOG_BYTES) return;

    const content = await this.adapter.read(this.path);
    const tail = content.slice(Math.floor(content.length / 2));
    const cut = tail.indexOf("\n");
    await this.adapter.write(
      this.path,
      `[лог обрезан ${formatTimestamp(Date.now())}]\n` + (cut === -1 ? tail : tail.slice(cut + 1))
    );
  }

  async read(): Promise<string> {
    if (!(await this.adapter.exists(this.path))) return "";
    return this.adapter.read(this.path);
  }

  async clear(): Promise<void> {
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
  }
}

export function pushEntry(history: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  return [entry, ...history].slice(0, MAX_ENTRIES);
}
