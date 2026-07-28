/** Настройки плагина, снимок последней синхронизации и история прогонов. */
import { JournalEntry } from "./journal";

export type ConflictPolicy = "keep-both" | "local-wins" | "remote-wins" | "newest-wins";

/** Состояние одного файла на момент последней успешной синхронизации. */
export interface SnapshotEntry {
  md5: string;
  size: number;
  /** Локальный mtime — позволяет пропустить перехеширование не изменившихся файлов. */
  mtime: number;
}

export type Snapshot = Record<string, SnapshotEntry>;

export interface NobsiSyncSettings {
  token: string;
  remoteBase: string;
  deviceName: string;
  autoSync: boolean;
  intervalMinutes: number;
  syncOnStartup: boolean;
  conflictPolicy: ConflictPolicy;
  excludePatterns: string[];
  /** Локальные удаления — в .trash хранилища, а не безвозвратно. */
  trashLocalDeletes: boolean;
  maxFileSizeMb: number;
  concurrency: number;
  /** Снимок последней успешной синхронизации: путь -> состояние. */
  snapshot: Snapshot;
  lastSync: number;
  /** История прогонов, свежие первыми. */
  journal: JournalEntry[];
  /** Дублировать журнал в текстовый файл рядом с плагином. */
  logToFile: boolean;
}

/**
 * Служебные папки исключены всегда: .obsidian отключён по решению для первой
 * версии, .trash и .git к заметкам отношения не имеют.
 */
export const DEFAULT_EXCLUDES = [".obsidian", ".trash", ".git", ".DS_Store", "**/.DS_Store"];

export const DEFAULT_SETTINGS: NobsiSyncSettings = {
  token: "",
  remoteBase: "/Obsidian",
  deviceName: "",
  autoSync: false,
  intervalMinutes: 15,
  syncOnStartup: false,
  conflictPolicy: "keep-both",
  excludePatterns: [...DEFAULT_EXCLUDES],
  trashLocalDeletes: true,
  maxFileSizeMb: 100,
  concurrency: 4,
  snapshot: {},
  lastSync: 0,
  journal: [],
  logToFile: true,
};

export const CONFLICT_POLICY_LABELS: Record<ConflictPolicy, string> = {
  "keep-both": "Сохранять обе версии",
  "local-wins": "Локальная версия побеждает",
  "remote-wins": "Версия с Диска побеждает",
  "newest-wins": "Побеждает более свежая по времени",
};
