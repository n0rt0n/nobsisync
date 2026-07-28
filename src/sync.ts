import { DataAdapter, Vault } from "obsidian";
import { md5 } from "./md5";
import { NobsiSyncSettings, Snapshot } from "./settings";
import {
  basename,
  formatBytes,
  nfc,
  parentPath,
  PathFilter,
  pool,
  remoteJoin,
  splitExt,
  timestampLabel,
} from "./util";
import { RemoteFile, YandexDiskClient } from "./yandex";

/**
 * rel — ключ сопоставления сторон, всегда в NFC.
 * path — имя, под которым файл реально лежит в файловой системе.
 *
 * Разделять их обязательно: macOS хранит имена в NFD, но ищет без учёта
 * нормализации, поэтому там NFC-путь открывает NFD-файл. NTFS и ext4 сравнивают
 * байты буквально — на Windows и Linux обращение к NFD-файлу по NFC-имени
 * приводит к «файл не найден».
 */
export interface LocalFile {
  rel: string;
  path: string;
  md5: string;
  size: number;
  mtime: number;
}

export type ActionKind =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "conflict"
  | "record"
  | "skip";

export interface Action {
  kind: ActionKind;
  rel: string;
  reason: string;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  unchanged: number;
  errors: { rel: string; message: string }[];
  /** Что реально перенесено — для журнала. Заполняется только по факту успеха. */
  changes: { kind: ActionKind; rel: string }[];
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
  /** Сколько обращений к API Диска стоил прогон. */
  requests: number;
}

export type ProgressFn = (done: number, total: number, label: string) => void;

/** Состояние стороны относительно снимка последней синхронизации. */
type Side = "absent" | "new" | "unchanged" | "modified" | "deleted";

function classify(
  current: { md5: string } | undefined,
  base: { md5: string } | undefined
): Side {
  if (!current && !base) return "absent";
  if (!current) return "deleted";
  if (!base) return "new";
  return current.md5 === base.md5 ? "unchanged" : "modified";
}

/** Рекурсивно обходит хранилище, пропуская исключённые пути. */
export async function scanLocal(
  adapter: DataAdapter,
  filter: PathFilter,
  snapshot: Snapshot,
  maxBytes: number
): Promise<{ files: Map<string, LocalFile>; skipped: string[] }> {
  const files = new Map<string, LocalFile>();
  const skipped: string[] = [];
  const dirs: string[] = ["/"];

  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    const listing = await adapter.list(dir);

    for (const folder of listing.folders) {
      const rel = nfc(folder);
      if (filter.isExcluded(rel)) continue;
      dirs.push(folder);
    }

    for (const file of listing.files) {
      const rel = nfc(file);
      if (filter.isExcluded(rel)) continue;

      const stat = await adapter.stat(file);
      if (!stat || stat.type !== "file") continue;

      if (maxBytes > 0 && stat.size > maxBytes) {
        skipped.push(rel);
        continue;
      }

      // Если размер и mtime совпали со снимком — содержимое почти наверняка то же.
      // Это экономит чтение и хеширование всего хранилища на каждой синхронизации.
      const base = snapshot[rel];
      let hash: string;
      if (base && base.size === stat.size && base.mtime === stat.mtime) {
        hash = base.md5;
      } else {
        hash = md5(await adapter.readBinary(file));
      }

      files.set(rel, { rel, path: file, md5: hash, size: stat.size, mtime: stat.mtime });
    }
  }

  return { files, skipped };
}

/** Строит план действий по трёхстороннему сравнению: локально / Диск / снимок. */
export function buildPlan(
  local: Map<string, LocalFile>,
  remote: Map<string, RemoteFile>,
  snapshot: Snapshot,
  policy: NobsiSyncSettings["conflictPolicy"]
): Action[] {
  const paths = new Set<string>([
    ...local.keys(),
    ...remote.keys(),
    ...Object.keys(snapshot),
  ]);

  const plan: Action[] = [];

  for (const rel of paths) {
    const l = local.get(rel);
    const r = remote.get(rel);
    const base = snapshot[rel];

    const ls = classify(l, base);
    const rs = classify(r, base);

    // Содержимое совпало — что бы ни случилось, синхронизировать нечего.
    if (l && r && l.md5 === r.md5) {
      plan.push({ kind: "record", rel, reason: "содержимое совпадает" });
      continue;
    }

    if (ls === "absent" && rs === "absent") continue;

    // Обе стороны удалили файл — остаётся вычистить его из снимка.
    if (ls === "deleted" && rs === "deleted") {
      plan.push({ kind: "record", rel, reason: "удалён с обеих сторон" });
      continue;
    }

    if (ls === "unchanged" && rs === "unchanged") {
      plan.push({ kind: "record", rel, reason: "без изменений" });
      continue;
    }

    // Изменения ровно с одной стороны — направление очевидно.
    if ((ls === "new" || ls === "modified") && (rs === "unchanged" || rs === "absent")) {
      plan.push({ kind: "upload", rel, reason: ls === "new" ? "создан локально" : "изменён локально" });
      continue;
    }
    if ((rs === "new" || rs === "modified") && (ls === "unchanged" || ls === "absent")) {
      plan.push({ kind: "download", rel, reason: rs === "new" ? "создан на Диске" : "изменён на Диске" });
      continue;
    }
    if (ls === "unchanged" && rs === "deleted") {
      plan.push({ kind: "delete-local", rel, reason: "удалён на Диске" });
      continue;
    }
    if (rs === "unchanged" && ls === "deleted") {
      plan.push({ kind: "delete-remote", rel, reason: "удалён локально" });
      continue;
    }

    // Удаление против правки: правка важнее — файл воскресает.
    if (ls === "modified" && rs === "deleted") {
      plan.push({ kind: "upload", rel, reason: "изменён локально, удалён на Диске" });
      continue;
    }
    if (rs === "modified" && ls === "deleted") {
      plan.push({ kind: "download", rel, reason: "удалён локально, изменён на Диске" });
      continue;
    }

    // Обе стороны меняли файл по-разному — конфликт.
    if (l && r) {
      if (policy === "local-wins") {
        plan.push({ kind: "upload", rel, reason: "конфликт, побеждает локальная версия" });
      } else if (policy === "remote-wins") {
        plan.push({ kind: "download", rel, reason: "конфликт, побеждает версия с Диска" });
      } else if (policy === "newest-wins") {
        const localNewer = l.mtime >= r.modified;
        plan.push({
          kind: localNewer ? "upload" : "download",
          rel,
          reason: localNewer ? "конфликт, локальная свежее" : "конфликт, версия с Диска свежее",
        });
      } else {
        plan.push({ kind: "conflict", rel, reason: "изменён с обеих сторон" });
      }
      continue;
    }

    // Сюда попадать не должно, но молча терять файл нельзя.
    plan.push({ kind: "skip", rel, reason: `неразобранный случай (${ls}/${rs})` });
  }

  return plan;
}

export class SyncEngine {
  constructor(
    private vault: Vault,
    private client: YandexDiskClient,
    private settings: NobsiSyncSettings
  ) {}

  private get adapter(): DataAdapter {
    return this.vault.adapter;
  }

  private abs(rel: string): string {
    return remoteJoin(this.settings.remoteBase, rel);
  }

  async run(progress: ProgressFn): Promise<SyncReport> {
    const startedAt = Date.now();
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      skipped: 0,
      unchanged: 0,
      errors: [],
      changes: [],
      bytesUp: 0,
      bytesDown: 0,
      durationMs: 0,
      requests: 0,
    };

    // Счётчик запросов и кэш папок живут в пределах одного прогона.
    this.client.resetRunState();

    const filter = new PathFilter(this.settings.excludePatterns);
    const maxBytes = this.settings.maxFileSizeMb * 1024 * 1024;
    const snapshot = this.settings.snapshot;

    progress(0, 1, "Сканирование хранилища…");
    const { files: local, skipped } = await scanLocal(this.adapter, filter, snapshot, maxBytes);
    report.skipped = skipped.length;

    progress(0, 1, "Чтение Яндекс.Диска…");
    const remoteList = await this.client.listVault(this.settings.remoteBase);
    const remote = new Map<string, RemoteFile>();
    // Ключ карты — NFC, а RemoteFile.rel остаётся тем, что реально лежит на Диске:
    // обращаться к файлу нужно его настоящим именем, иначе API вернёт 404.
    for (const f of remoteList) {
      const key = nfc(f.rel);
      if (filter.isExcluded(key)) continue;
      remote.set(key, f);
    }

    const plan = buildPlan(local, remote, snapshot, this.settings.conflictPolicy);
    const work = plan.filter((a) => a.kind !== "record" && a.kind !== "skip");
    report.unchanged = plan.length - work.length;

    // "record" — содержимое сошлось само: просто фиксируем состояние в снимке.
    for (const action of plan) {
      if (action.kind !== "record") continue;
      const l = local.get(action.rel);
      if (l) {
        snapshot[action.rel] = { md5: l.md5, size: l.size, mtime: l.mtime };
      } else {
        delete snapshot[action.rel];
      }
    }

    let done = 0;
    const total = work.length;
    if (total === 0) {
      report.durationMs = Date.now() - startedAt;
      report.requests = this.client.requestCount;
      return report;
    }

    await pool(work, Math.max(1, this.settings.concurrency), async (action) => {
      try {
        await this.execute(action, local, remote, snapshot, report);
        report.changes.push({ kind: action.kind, rel: action.rel });
      } catch (e) {
        report.errors.push({ rel: action.rel, message: (e as Error).message });
      } finally {
        done++;
        progress(done, total, action.rel);
      }
    });

    report.durationMs = Date.now() - startedAt;
    report.requests = this.client.requestCount;
    return report;
  }

  private async execute(
    action: Action,
    local: Map<string, LocalFile>,
    remote: Map<string, RemoteFile>,
    snapshot: Snapshot,
    report: SyncReport
  ): Promise<void> {
    const { rel } = action;

    // rel — NFC-ключ. Для обращения к уже существующему файлу берём его
    // настоящее имя; для создаваемого канонической формой служит NFC.
    const localPath = local.get(rel)?.path ?? rel;
    const remotePath = this.abs(remote.get(rel)?.rel ?? rel);

    switch (action.kind) {
      case "upload": {
        const data = await this.adapter.readBinary(localPath);
        await this.client.upload(remotePath, data);
        await this.recordLocal(rel, localPath, snapshot, data);
        report.uploaded++;
        report.bytesUp += data.byteLength;
        return;
      }

      case "download": {
        const data = await this.client.download(remotePath);
        await this.writeLocal(localPath, data);
        await this.recordLocal(rel, localPath, snapshot, data);
        report.downloaded++;
        report.bytesDown += data.byteLength;
        return;
      }

      case "delete-local": {
        await this.removeLocal(localPath);
        delete snapshot[rel];
        report.deletedLocal++;
        return;
      }

      case "delete-remote": {
        await this.client.remove(remotePath);
        delete snapshot[rel];
        report.deletedRemote++;
        return;
      }

      case "conflict": {
        await this.resolveKeepBoth(rel, localPath, remotePath, snapshot, report);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Разрешение конфликта без потерь: локальная версия уезжает в файл с пометкой,
   * каноническим именем становится версия с Диска, а переименованная копия
   * уходит на Диск. Оба устройства в итоге видят обе версии под одинаковыми
   * именами — состояние сходится.
   */
  private async resolveKeepBoth(
    rel: string,
    localPath: string,
    remotePath: string,
    snapshot: Snapshot,
    report: SyncReport
  ): Promise<void> {
    const dir = parentPath(rel);
    const [stem, ext] = splitExt(basename(rel));
    const device = this.settings.deviceName.trim() || "устройство";
    const marker = `${stem} (конфликт ${device} ${timestampLabel(Date.now())})${ext}`;
    // Имя собрано из NFC-ключа, поэтому новый файл сразу создаётся в NFC.
    const conflictRel = dir ? `${dir}/${marker}` : marker;

    // adapter.rename, а не vault.rename: перелинковывать заметки на конфликтную
    // копию не нужно — ссылки должны остаться на каноническом имени.
    await this.adapter.rename(localPath, conflictRel);

    const remoteData = await this.client.download(remotePath);
    await this.writeLocal(rel, remoteData);
    await this.recordLocal(rel, rel, snapshot, remoteData);
    report.bytesDown += remoteData.byteLength;

    const localData = await this.adapter.readBinary(conflictRel);
    await this.client.upload(this.abs(conflictRel), localData);
    await this.recordLocal(conflictRel, conflictRel, snapshot, localData);
    report.bytesUp += localData.byteLength;

    report.conflicts++;
  }

  private async writeLocal(rel: string, data: ArrayBuffer): Promise<void> {
    const dir = parentPath(rel);
    if (dir && !(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }
    await this.adapter.writeBinary(rel, data);
  }

  private async removeLocal(rel: string): Promise<void> {
    if (!(await this.adapter.exists(rel))) return;
    if (this.settings.trashLocalDeletes) {
      // trashLocal кладёт файл в .trash хранилища — удаление остаётся обратимым.
      await this.adapter.trashLocal(rel);
    } else {
      await this.adapter.remove(rel);
    }
  }

  /**
   * Фиксирует в снимке фактическое состояние файла после переноса.
   *
   * mtime берётся из свежего stat, а не из того, что было до записи: именно по
   * паре (size, mtime) следующее сканирование решает, можно ли не перехешировать
   * файл. known — уже посчитанный хеш содержимого, чтобы не читать файл повторно.
   */
  private async recordLocal(
    rel: string,
    localPath: string,
    snapshot: Snapshot,
    known?: ArrayBuffer
  ): Promise<void> {
    const stat = await this.adapter.stat(localPath);
    if (!stat) {
      delete snapshot[rel];
      return;
    }
    const data = known ?? (await this.adapter.readBinary(localPath));

    // Если файл успели изменить прямо во время переноса, размер на диске разойдётся
    // с тем, что мы перенесли. Пишем заведомо невозможный mtime, чтобы следующее
    // сканирование не поверило паре (size, mtime) и перехешировало файл заново.
    const changedUnderUs = stat.size !== data.byteLength;
    snapshot[rel] = {
      md5: md5(data),
      size: data.byteLength,
      mtime: changedUnderUs ? -1 : stat.mtime,
    };
  }
}

export function describeReport(r: SyncReport): string {
  const parts: string[] = [];
  if (r.uploaded) parts.push(`↑ ${r.uploaded}`);
  if (r.downloaded) parts.push(`↓ ${r.downloaded}`);
  if (r.deletedLocal) parts.push(`удалено локально ${r.deletedLocal}`);
  if (r.deletedRemote) parts.push(`удалено на Диске ${r.deletedRemote}`);
  if (r.conflicts) parts.push(`конфликтов ${r.conflicts}`);
  if (r.skipped) parts.push(`пропущено ${r.skipped}`);
  if (r.errors.length) parts.push(`ошибок ${r.errors.length}`);
  if (parts.length === 0) return "Изменений нет";
  const traffic =
    r.bytesUp || r.bytesDown
      ? ` (${formatBytes(r.bytesUp)} ↑ / ${formatBytes(r.bytesDown)} ↓)`
      : "";
  return parts.join(", ") + traffic;
}
