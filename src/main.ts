import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import {
  CONFLICT_POLICY_LABELS,
  ConflictPolicy,
  DEFAULT_EXCLUDES,
  DEFAULT_SETTINGS,
  NobsiSyncSettings,
} from "./settings";
import {
  entryFromReport,
  failedEntry,
  formatTimestamp,
  JournalEntry,
  pushEntry,
  summarize,
  SyncLogFile,
} from "./journal";
import { JournalModal } from "./journal-modal";
import { describeReport, SyncEngine, SyncReport } from "./sync";
import { formatBytes } from "./util";
import { YandexDiskClient, YandexError } from "./yandex";

export default class NobsiSyncPlugin extends Plugin {
  settings!: NobsiSyncSettings;
  client!: YandexDiskClient;

  logFile: SyncLogFile | null = null;

  private statusBar: HTMLElement | null = null;
  /** Защита от параллельных запусков: две синхронизации разом растопчут снимок. */
  private syncing = false;
  private lastAutoSync = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new YandexDiskClient(() => this.settings.token);

    // Лог кладём рядом с самим плагином: папка .obsidian исключена из
    // синхронизации, так что журнал остаётся локальным для устройства.
    if (this.logPath) {
      this.logFile = new SyncLogFile(this.app.vault.adapter, this.logPath);
    }

    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
    }
    this.renderStatus();

    this.addRibbonIcon("refresh-cw", "NObsiSync: синхронизировать", () => {
      void this.syncNow("вручную");
    });

    this.addCommand({
      id: "sync-now",
      name: "Синхронизировать сейчас",
      callback: () => void this.syncNow("вручную"),
    });

    this.addCommand({
      id: "check-connection",
      name: "Проверить подключение к Яндекс.Диску",
      callback: () => void this.checkConnection(),
    });

    this.addCommand({
      id: "show-journal",
      name: "Показать журнал синхронизаций",
      callback: () => this.openJournal(),
    });

    this.addCommand({
      id: "reset-snapshot",
      name: "Сбросить снимок синхронизации",
      callback: () => void this.resetSnapshot(),
    });

    this.addSettingTab(new NobsiSyncSettingTab(this.app, this));

    // Проверяем раз в минуту, а не заводим таймер на весь интервал: так изменение
    // интервала в настройках вступает в силу сразу, без перезапуска плагина.
    this.registerInterval(
      window.setInterval(() => void this.maybeAutoSync(), 60_000)
    );

    if (this.settings.syncOnStartup && this.settings.token) {
      // Даём Obsidian закончить индексацию хранилища, иначе сканирование
      // конкурирует с первичной загрузкой и заметно тормозит запуск.
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => void this.syncNow("при запуске"), 3000);
      });
    }
  }

  onunload(): void {
    // Таймеры и статус-бар снимает сам Obsidian через registerInterval/addStatusBarItem.
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<NobsiSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});

    // Снимок и список исключений — объекты; Object.assign копирует ссылку на
    // дефолт, поэтому подменяем их явно, чтобы не мутировать DEFAULT_SETTINGS.
    this.settings.snapshot = stored?.snapshot ?? {};
    this.settings.excludePatterns = stored?.excludePatterns ?? [...DEFAULT_EXCLUDES];

    if (!this.settings.deviceName) {
      this.settings.deviceName = Platform.isMobile ? "телефон" : "компьютер";
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Путь к текстовому логу внутри папки плагина. */
  get logPath(): string | null {
    return this.manifest.dir ? `${this.manifest.dir}/sync.log` : null;
  }

  openJournal(): void {
    new JournalModal(
      this.app,
      this.settings.journal,
      this.settings.logToFile ? this.logPath : null
    ).open();
  }

  /** Кладёт запись в историю и, если включено, дописывает её в лог-файл. */
  private async recordJournal(entry: JournalEntry): Promise<void> {
    this.settings.journal = pushEntry(this.settings.journal, entry);
    await this.saveSettings();
    if (this.settings.logToFile && this.logFile) {
      await this.logFile.append(entry);
    }
  }

  private renderStatus(text?: string): void {
    if (!this.statusBar) return;
    if (text) {
      this.statusBar.setText(`⟳ ${text}`);
      return;
    }
    if (!this.settings.lastSync) {
      this.statusBar.setText("⟳ не синхронизировано");
      return;
    }
    const d = new Date(this.settings.lastSync);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    this.statusBar.setText(`⟳ ${hh}:${mm}`);
  }

  private async maybeAutoSync(): Promise<void> {
    if (!this.settings.autoSync || !this.settings.token || this.syncing) return;
    const elapsed = Date.now() - this.lastAutoSync;
    if (elapsed < this.settings.intervalMinutes * 60_000) return;
    this.lastAutoSync = Date.now();
    await this.syncNow("по расписанию", true);
  }

  async checkConnection(): Promise<void> {
    try {
      const account = await this.client.checkAccount();
      const free = account.totalSpace - account.usedSpace;
      new Notice(
        `Подключено: ${account.login}\nСвободно ${formatBytes(free)} из ${formatBytes(
          account.totalSpace
        )}`,
        7000
      );
    } catch (e) {
      new Notice(`Не удалось подключиться: ${(e as Error).message}`, 8000);
    }
  }

  async resetSnapshot(): Promise<void> {
    this.settings.snapshot = {};
    await this.saveSettings();
    new Notice(
      "Снимок сброшен. Следующая синхронизация сравнит стороны заново и объединит их содержимое.",
      8000
    );
  }

  async syncNow(trigger: string, silent = false): Promise<void> {
    if (this.syncing) {
      if (!silent) new Notice("Синхронизация уже идёт");
      return;
    }
    if (!this.settings.token.trim()) {
      new Notice("Сначала задайте OAuth-токен в настройках NObsiSync");
      return;
    }

    this.syncing = true;
    const startedAt = Date.now();
    const notice = silent ? null : new Notice("NObsiSync: синхронизация…", 0);

    try {
      const engine = new SyncEngine(this.app.vault, this.client, this.settings);
      const report = await engine.run((done, total, label) => {
        const text = total > 1 ? `${done}/${total} ${label}` : label;
        this.renderStatus(text);
        notice?.setMessage(`NObsiSync: ${text}`);
      });

      this.settings.lastSync = Date.now();
      await this.recordJournal(entryFromReport(report, trigger, this.settings.lastSync));
      this.renderStatus();

      const summary = describeReport(report);
      notice?.hide();

      if (report.errors.length > 0) {
        new Notice(`NObsiSync (${trigger}): ${summary}\nПодробности — в журнале синхронизаций.`, 10000);
        this.logErrors(report);
      } else if (!silent || report.uploaded || report.downloaded || report.conflicts) {
        new Notice(`NObsiSync: ${summary}`, 5000);
      }
    } catch (e) {
      notice?.hide();
      this.renderStatus();
      const err = e as Error;
      const hint =
        err instanceof YandexError && err.isAuthFailure
          ? "\nПроверьте OAuth-токен в настройках."
          : "";
      new Notice(`NObsiSync: синхронизация не удалась — ${err.message}${hint}`, 10000);
      console.error("[NObsiSync] сбой синхронизации", err);
      // Сбой обязан осесть в журнале: иначе о ночном падении автосинхронизации
      // не останется вообще никакого следа.
      await this.recordJournal(failedEntry(trigger, Date.now(), err.message, Date.now() - startedAt));
    } finally {
      this.syncing = false;
    }
  }

  private logErrors(report: SyncReport): void {
    console.group("[NObsiSync] файлы с ошибками");
    for (const e of report.errors) console.error(`${e.rel}: ${e.message}`);
    console.groupEnd();
  }
}

class NobsiSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: NobsiSyncPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderSchedule(containerEl);
    this.renderBehaviour(containerEl);
    this.renderJournal(containerEl);
    this.renderMaintenance(containerEl);
  }

  private renderJournal(root: HTMLElement): void {
    new Setting(root).setName("Журнал").setHeading();

    const entries = this.plugin.settings.journal;

    if (entries.length === 0) {
      root.createEl("p", {
        cls: "nobsisync-journal-empty",
        text: "Пока пусто — записи появятся после первой синхронизации.",
      });
    } else {
      const list = root.createDiv({ cls: "nobsisync-journal-recent" });
      for (const entry of entries.slice(0, 5)) {
        const status = entry.fatal ? "fail" : entry.errors.length ? "warn" : "ok";
        const row = list.createDiv({ cls: `nobsisync-recent-row nobsisync-${status}` });
        row.createSpan({ cls: "nobsisync-entry-time", text: formatTimestamp(entry.ts) });
        row.createSpan({ cls: "nobsisync-entry-trigger", text: entry.trigger });
        row.createSpan({ cls: "nobsisync-entry-summary", text: summarize(entry) });
      }
    }

    new Setting(root)
      .setName("История синхронизаций")
      .setDesc(`Хранятся последние ${entries.length} из 50 прогонов`)
      .addButton((btn) =>
        btn
          .setButtonText("Открыть журнал")
          .setCta()
          .onClick(() => this.plugin.openJournal())
      );

    new Setting(root)
      .setName("Писать лог в файл")
      .setDesc(
        this.plugin.logPath
          ? `Текстовый лог в ${this.plugin.logPath} — его можно открыть с телефона и грепать`
          : "Путь к папке плагина недоступен"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.logToFile).onChange(async (value) => {
          this.plugin.settings.logToFile = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(root)
      .setName("Очистить журнал")
      .setDesc("Удаляет историю прогонов и лог-файл. На синхронизацию не влияет.")
      .addButton((btn) =>
        btn
          .setButtonText("Очистить")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.journal = [];
            await this.plugin.saveSettings();
            await this.plugin.logFile?.clear();
            new Notice("Журнал очищен");
            this.display();
          })
      );
  }

  private renderConnection(root: HTMLElement): void {
    new Setting(root).setName("Подключение").setHeading();

    const help = root.createEl("div", { cls: "nobsisync-help" });
    help.createEl("p", {
      text: "Токен получается один раз: создайте приложение на oauth.yandex.ru с правами на Яндекс.Диск (cloud_api:disk.read и cloud_api:disk.write), укажите redirect на https://oauth.yandex.ru/verification_code, откройте ссылку авторизации и скопируйте выданный токен сюда.",
    });
    help.createEl("p", {
      text: "Токен хранится в data.json плагина в открытом виде — как и у любого плагина Obsidian. Не синхронизируйте папку .obsidian через публичные каналы.",
      cls: "nobsisync-warn",
    });

    new Setting(root)
      .setName("OAuth-токен")
      .setDesc("Токен доступа к Яндекс.Диску")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("y0_Aga...")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(root)
      .setName("Папка на Диске")
      .setDesc("Куда складывать хранилище. Будет создана, если её нет.")
      .addText((text) =>
        text
          .setPlaceholder("/Obsidian")
          .setValue(this.plugin.settings.remoteBase)
          .onChange(async (value) => {
            this.plugin.settings.remoteBase = value.trim() || "/Obsidian";
            await this.plugin.saveSettings();
          })
      );

    new Setting(root)
      .setName("Имя устройства")
      .setDesc("Подставляется в имена конфликтных копий")
      .addText((text) =>
        text
          .setPlaceholder("ноутбук")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(root).addButton((btn) =>
      btn
        .setButtonText("Проверить подключение")
        .setCta()
        .onClick(() => void this.plugin.checkConnection())
    );
  }

  private renderSchedule(root: HTMLElement): void {
    new Setting(root).setName("Запуск").setHeading();

    new Setting(root)
      .setName("Автоматическая синхронизация")
      .setDesc("Запускать периодически в фоне")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(root)
      .setName("Интервал")
      .setDesc("Как часто синхронизировать, в минутах")
      .addSlider((s) =>
        s
          .setLimits(1, 120, 1)
          .setValue(this.plugin.settings.intervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.intervalMinutes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(root)
      .setName("Синхронизировать при запуске")
      .setDesc("Через несколько секунд после открытия хранилища")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderBehaviour(root: HTMLElement): void {
    new Setting(root).setName("Поведение").setHeading();

    new Setting(root)
      .setName("Конфликты")
      .setDesc("Что делать, если файл изменён и здесь, и на Диске")
      .addDropdown((d) => {
        for (const [key, label] of Object.entries(CONFLICT_POLICY_LABELS)) {
          d.addOption(key, label);
        }
        d.setValue(this.plugin.settings.conflictPolicy).onChange(async (value) => {
          this.plugin.settings.conflictPolicy = value as ConflictPolicy;
          await this.plugin.saveSettings();
        });
      });

    new Setting(root)
      .setName("Исключения")
      .setDesc("По шаблону на строку. Поддерживаются * и **. Путь исключается вместе со всем содержимым.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 6;
        ta.inputEl.addClass("nobsisync-excludes");
        ta.setValue(this.plugin.settings.excludePatterns.join("\n")).onChange(async (value) => {
          this.plugin.settings.excludePatterns = value
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    new Setting(root)
      .setName("Удалять локально в корзину")
      .setDesc("Файлы, удалённые на Диске, попадут в .trash хранилища, а не исчезнут")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.trashLocalDeletes).onChange(async (value) => {
          this.plugin.settings.trashLocalDeletes = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(root)
      .setName("Максимальный размер файла")
      .setDesc("Файлы крупнее пропускаются: перенос идёт целиком в памяти. 0 — без ограничения.")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxFileSizeMb))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) return;
            this.plugin.settings.maxFileSizeMb = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(root)
      .setName("Параллельных передач")
      .setDesc("Больше — быстрее, но выше шанс упереться в лимит запросов Диска")
      .addSlider((s) =>
        s
          .setLimits(1, 8, 1)
          .setValue(this.plugin.settings.concurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.concurrency = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderMaintenance(root: HTMLElement): void {
    new Setting(root).setName("Обслуживание").setHeading();

    const tracked = Object.keys(this.plugin.settings.snapshot).length;
    const lastEntry = this.plugin.settings.journal[0];
    const last = this.plugin.settings.lastSync
      ? formatTimestamp(this.plugin.settings.lastSync)
      : "никогда";
    const outcome = lastEntry ? ` Итог: ${summarize(lastEntry)}.` : "";

    new Setting(root)
      .setName("Состояние")
      .setDesc(`Последняя синхронизация: ${last}. Файлов в снимке: ${tracked}.${outcome}`);

    new Setting(root)
      .setName("Сбросить снимок")
      .setDesc(
        "Плагин забудет, что было синхронизировано. Ничего не удаляется: стороны сравнятся заново и объединятся, различающиеся версии разойдутся по конфликтным копиям."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Сбросить")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSnapshot();
            this.display();
          })
      );
  }
}
