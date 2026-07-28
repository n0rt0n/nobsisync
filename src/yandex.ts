import { requestUrl, RequestUrlResponse } from "obsidian";
import { remoteJoin, remoteToRelative, sleep, trimSlashes } from "./util";

/**
 * Клиент REST API Яндекс.Диска.
 *
 * Все запросы идут через requestUrl() из Obsidian, а не через fetch: requestUrl
 * ходит мимо CORS и одинаково работает на десктопе и на мобильных. Готовые
 * npm-клиенты внутри используют fetch/XHR и на телефоне падают.
 */

const API = "https://cloud-api.yandex.net/v1/disk";

/** Поля листинга: просим только нужное, чтобы не тащить лишние килобайты. */
const LIST_FIELDS = [
  "_embedded.total",
  "_embedded.offset",
  "_embedded.limit",
  "_embedded.items.path",
  "_embedded.items.type",
  "_embedded.items.md5",
  "_embedded.items.size",
  "_embedded.items.modified",
].join(",");

const PAGE_SIZE = 200;
const MAX_RETRIES = 4;

export interface RemoteFile {
  /** Путь относительно корневой папки синхронизации, в NFC. */
  rel: string;
  md5: string;
  size: number;
  modified: number;
}

export class YandexError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "YandexError";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

interface RawItem {
  path: string;
  type: "dir" | "file";
  md5?: string;
  size?: number;
  modified?: string;
}

export class YandexDiskClient {
  /** Счётчик обращений к сети — попадает в журнал, чтобы видеть реальный расход. */
  requestCount = 0;

  /**
   * Папки, о существовании которых уже известно из листинга или созданные нами.
   * Без этого кэша ensureDirChain дёргал бы PUT на каждый сегмент пути при
   * каждой выгрузке, получая 409 «уже существует» и тратя запросы впустую.
   */
  private knownDirs = new Set<string>();

  constructor(private getToken: () => string) {}

  /** Вызывается в начале прогона: кэш живёт ровно одну синхронизацию. */
  resetRunState(): void {
    this.requestCount = 0;
    this.knownDirs.clear();
  }

  private authHeader(): Record<string, string> {
    const token = this.getToken().trim();
    if (!token) throw new YandexError("OAuth-токен не задан в настройках", 401);
    return { Authorization: `OAuth ${token}` };
  }

  /**
   * Запрос с ретраями. Повторяем только то, что имеет смысл повторять:
   * 429 (лимит запросов) и 5xx. На 4xx повтор ничего не изменит.
   */
  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: ArrayBuffer | string } = {
      method: "GET",
    }
  ): Promise<RequestUrlResponse> {
    let lastError: YandexError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.requestCount++;
      let res: RequestUrlResponse;
      try {
        res = await requestUrl({
          url,
          method: init.method,
          headers: init.headers,
          body: init.body,
          throw: false,
        });
      } catch (e) {
        // Сетевой сбой (нет соединения, обрыв) — requestUrl бросает до получения статуса.
        lastError = new YandexError(`Сетевая ошибка: ${(e as Error).message}`, 0);
        if (attempt === MAX_RETRIES) break;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status >= 200 && res.status < 300) return res;

      const err = this.toError(res);
      lastError = err;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) break;

      const retryAfter = Number(res.headers?.["retry-after"] ?? res.headers?.["Retry-After"]);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await sleep(delay);
    }

    throw lastError ?? new YandexError("Неизвестная ошибка запроса", 0);
  }

  private toError(res: RequestUrlResponse): YandexError {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = res.json as { message?: string; description?: string; error?: string } | undefined;
      if (body) {
        code = body.error;
        message = body.message ?? body.description ?? message;
      }
    } catch {
      // тело не JSON — оставляем текст по статусу
    }
    if (res.status === 401) message = "Токен недействителен или истёк";
    if (res.status === 507) message = "На Яндекс.Диске закончилось место";
    return new YandexError(message, res.status, code);
  }

  private apiUrl(path: string, params: Record<string, string> = {}): string {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    return `${API}${path}${qs ? `?${qs}` : ""}`;
  }

  /** Проверка токена: возвращает логин владельца и остаток места. */
  async checkAccount(): Promise<{ login: string; totalSpace: number; usedSpace: number }> {
    const res = await this.request(this.apiUrl("", { fields: "user.login,total_space,used_space" }), {
      method: "GET",
      headers: this.authHeader(),
    });
    const body = res.json as {
      user?: { login?: string };
      total_space?: number;
      used_space?: number;
    };
    return {
      login: body.user?.login ?? "(неизвестен)",
      totalSpace: body.total_space ?? 0,
      usedSpace: body.used_space ?? 0,
    };
  }

  /** Создаёт папку. Уже существующая (409) — не ошибка. */
  async ensureDir(absPath: string): Promise<void> {
    if (this.knownDirs.has(absPath)) return;
    try {
      await this.request(this.apiUrl("/resources", { path: absPath }), {
        method: "PUT",
        headers: this.authHeader(),
      });
    } catch (e) {
      if (!(e instanceof YandexError) || e.status !== 409) throw e;
    }
    this.knownDirs.add(absPath);
  }

  /** Создаёт всю цепочку родительских папок сверху вниз. */
  async ensureDirChain(absPath: string): Promise<void> {
    const parts = trimSlashes(absPath).split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      await this.ensureDir(acc);
    }
  }

  /**
   * Рекурсивный обход папки синхронизации.
   * Если базовой папки ещё нет — создаём её и возвращаем пустой список.
   */
  async listVault(base: string): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    const queue: string[] = [remoteJoin(base, "")];
    let baseMissing = false;

    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let offset = 0;

      for (;;) {
        let res: RequestUrlResponse;
        try {
          res = await this.request(
            this.apiUrl("/resources", {
              path: dir,
              limit: String(PAGE_SIZE),
              offset: String(offset),
              fields: LIST_FIELDS,
            }),
            { method: "GET", headers: this.authHeader() }
          );
        } catch (e) {
          if (e instanceof YandexError && e.isNotFound) {
            if (dir === remoteJoin(base, "")) baseMissing = true;
            break; // папку удалили между обходами — просто пропускаем
          }
          throw e;
        }

        const embedded = (res.json as { _embedded?: { items?: RawItem[]; total?: number } })._embedded;
        const items = embedded?.items ?? [];

        // Раз папка успешно перечислена — она существует, создавать её не нужно.
        this.knownDirs.add(dir);

        for (const item of items) {
          if (item.type === "dir") {
            const child = item.path.replace(/^disk:/, "");
            this.knownDirs.add(child);
            queue.push(child);
            continue;
          }
          const rel = remoteToRelative(base, item.path);
          if (rel === null || rel === "") continue;
          out.push({
            rel,
            md5: item.md5 ?? "",
            size: item.size ?? 0,
            modified: item.modified ? Date.parse(item.modified) : 0,
          });
        }

        offset += items.length;
        const total = embedded?.total ?? 0;
        if (items.length === 0 || offset >= total) break;
      }
    }

    if (baseMissing) await this.ensureDirChain(remoteJoin(base, ""));
    return out;
  }

  async download(absPath: string): Promise<ArrayBuffer> {
    const meta = await this.request(this.apiUrl("/resources/download", { path: absPath }), {
      method: "GET",
      headers: this.authHeader(),
    });
    const href = (meta.json as { href?: string }).href;
    if (!href) throw new YandexError("Диск не вернул ссылку на скачивание", 0);

    // Ссылка уже подписана — OAuth-заголовок к ней не прикладываем.
    const res = await this.request(href, { method: "GET" });
    return res.arrayBuffer;
  }

  async upload(absPath: string, data: ArrayBuffer): Promise<void> {
    await this.ensureDirChain(absPath.slice(0, absPath.lastIndexOf("/")));

    const meta = await this.request(
      this.apiUrl("/resources/upload", { path: absPath, overwrite: "true" }),
      { method: "GET", headers: this.authHeader() }
    );
    const href = (meta.json as { href?: string }).href;
    if (!href) throw new YandexError("Диск не вернул ссылку на загрузку", 0);

    await this.request(href, { method: "PUT", body: data });
  }

  /** Удаление в корзину Диска (permanently=false) — восстановимо. */
  async remove(absPath: string, permanently = false): Promise<void> {
    try {
      await this.request(
        this.apiUrl("/resources", { path: absPath, permanently: String(permanently) }),
        { method: "DELETE", headers: this.authHeader() }
      );
    } catch (e) {
      if (e instanceof YandexError && e.isNotFound) return; // уже удалён
      throw e;
    }
  }
}
