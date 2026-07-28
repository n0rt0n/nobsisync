import { App, Modal, Notice } from "obsidian";
import { formatEntry, formatTimestamp, JournalEntry, summarize } from "./journal";

/** Окно с историей синхронизаций. Записи разворачиваются по щелчку. */
export class JournalModal extends Modal {
  constructor(
    app: App,
    private entries: JournalEntry[],
    private logPath: string | null
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Журнал синхронизаций");
    contentEl.addClass("nobsisync-journal");

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "Пока ничего не записано — журнал появится после первой синхронизации." });
      return;
    }

    const toolbar = contentEl.createDiv({ cls: "nobsisync-journal-toolbar" });
    toolbar.createEl("button", { text: "Скопировать весь журнал" }).addEventListener("click", () => {
      void navigator.clipboard
        .writeText(this.entries.map(formatEntry).join("\n"))
        .then(() => new Notice("Журнал скопирован в буфер обмена"))
        .catch(() => new Notice("Не удалось скопировать"));
    });
    if (this.logPath) {
      toolbar.createEl("span", { cls: "nobsisync-journal-path", text: `Полный лог: ${this.logPath}` });
    }

    for (const entry of this.entries) {
      this.renderEntry(contentEl, entry);
    }
  }

  private renderEntry(root: HTMLElement, entry: JournalEntry): void {
    const status = entry.fatal ? "fail" : entry.errors.length ? "warn" : "ok";
    const details = root.createEl("details", { cls: `nobsisync-entry nobsisync-${status}` });

    const summaryEl = details.createEl("summary");
    summaryEl.createSpan({ cls: "nobsisync-entry-time", text: formatTimestamp(entry.ts) });
    summaryEl.createSpan({ cls: "nobsisync-entry-trigger", text: entry.trigger });
    summaryEl.createSpan({ cls: "nobsisync-entry-summary", text: summarize(entry) });

    const body = details.createDiv({ cls: "nobsisync-entry-body" });

    if (entry.fatal) {
      body.createDiv({ cls: "nobsisync-line nobsisync-error", text: `Прогон прерван: ${entry.fatal}` });
    }
    for (const err of entry.errors) {
      body.createDiv({ cls: "nobsisync-line nobsisync-error", text: `${err.rel} — ${err.message}` });
    }
    for (const change of entry.changes) {
      body.createDiv({ cls: "nobsisync-line", text: `${LABELS[change.kind] ?? change.kind}: ${change.rel}` });
    }
    if (entry.changesTruncated) {
      body.createDiv({ cls: "nobsisync-line nobsisync-muted", text: `… и ещё ${entry.changesTruncated} изменений` });
    }
    if (!entry.fatal && entry.errors.length === 0 && entry.changes.length === 0) {
      body.createDiv({ cls: "nobsisync-line nobsisync-muted", text: "Изменений не было." });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const LABELS: Record<string, string> = {
  upload: "выгружен",
  download: "загружен",
  "delete-local": "удалён локально",
  "delete-remote": "удалён на Диске",
  conflict: "конфликт",
};
