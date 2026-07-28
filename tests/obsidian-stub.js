// Заглушка модуля obsidian для тестов.
// Проверяемый код (buildPlan, SyncEngine, утилиты) обращается к файлам и сети
// только через переданные ему адаптер и клиент, поэтому настоящий API не нужен.
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export const Platform = { isMobile: false };
// Тест подменяет обработчик, чтобы проверять настоящий клиент Диска
// на смоделированных ответах API.
export function requestUrl(options) {
  const handler = globalThis.__nobsisyncRequest;
  if (!handler) throw new Error("requestUrl вызван, но обработчик в тесте не задан");
  return handler(options);
}
