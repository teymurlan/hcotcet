export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_CHAT_ID: string;
}

type State = "idle" | "awaiting_object" | "awaiting_address" | "confirm_address" | "before_photos" | "awaiting_defects" | "after_photos" | "confirm_finish";

interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; }
interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type?: string }; text?: string; photo?: TgPhotoSize[]; }
interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string; }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery; }

interface Session {
  state: State;
  objectName: string;
  address: string;
  beforePhotos: string[];
  afterPhotos: string[];
  defects: string;
  reportId: string;
  startedAt: string;
  beforeFinishedAt?: string;
  afterFinishedAt?: string;
  cleaner: TgUser;
}

const TELEGRAM_API = "https://api.telegram.org/bot";
const sessions = new Map<number, Session>();
const processedUpdates = new Set<number>();
const MAX_PROCESSED_UPDATES = 5000;
const MAX_PHOTOS_PER_PHASE = 50;

class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const token = this.token.trim();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
    const response = await fetch(`${TELEGRAM_API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let data: unknown;
    try { data = JSON.parse(body); } catch { data = body; }
    const ok = typeof data === "object" && data !== null && "ok" in data && (data as { ok: boolean }).ok === true;
    if (!response.ok || !ok) throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    return data as T;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  answerCallbackQuery(id: string, text?: string) { return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); }
  editMessageReplyMarkup(chatId: number, messageId: number) { return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
  sendMediaGroup(chatId: number, media: unknown[]) { return this.call("sendMediaGroup", { chat_id: chatId, media }); }
}

const MAIN_MENU = { inline_keyboard: [
  [{ text: "➕ Создать фотоотчёт", callback_data: "new_report" }],
  [{ text: "🗂 Мои отчёты", callback_data: "my_reports" }, { text: "👤 Профиль", callback_data: "profile" }],
  [{ text: "ℹ️ Помощь", callback_data: "help" }],
] };
const CANCEL = { inline_keyboard: [[{ text: "❌ Отменить отчёт", callback_data: "cancel" }]] };
const ADDRESS_MENU = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "back_object" }, { text: "❌ Отмена", callback_data: "cancel" }]] };
const CONFIRM_ADDRESS = { inline_keyboard: [[{ text: "✅ Да, всё верно", callback_data: "address_ok" }], [{ text: "✏️ Изменить", callback_data: "edit_address" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const DEFECT_MENU = { inline_keyboard: [[{ text: "✅ Нет дефектов", callback_data: "no_defects" }], [{ text: "❌ Отменить отчёт", callback_data: "cancel" }]] };
const CONFIRM_FINISH = { inline_keyboard: [[{ text: "✅ Да, завершить", callback_data: "confirm_finish" }], [{ text: "↩️ Продолжить фото", callback_data: "continue_after" }], [{ text: "❌ Отменить отчёт", callback_data: "cancel" }]] };

function photoMenu(phase: "before" | "after") {
  return { inline_keyboard: [[{ text: phase === "before" ? "✅ Завершить ДО" : "✅ Завершить ПОСЛЕ", callback_data: phase === "before" ? "finish_before" : "finish_after" }], [{ text: "❌ Отменить отчёт", callback_data: "cancel" }]] };
}

const HELP_TEXT = "<b>ℹ️ House Cleaning — Фотоотчёты</b>\n\n" +
  "Бот помогает сотруднику оформить фотоотчёт по объекту.\n\n" +
  "<b>Порядок:</b>\n1. Объект и адрес\n2. Фото ДО\n3. Дефекты до уборки\n4. Фото ПОСЛЕ\n5. Проверка и завершение\n\n" +
  "В любой момент можно нажать «Отмена» или отправить /start.";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function makeReportId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `HC-${code}`;
}

function newSession(cleaner: TgUser): Session {
  return { state: "awaiting_object", objectName: "", address: "", beforePhotos: [], afterPhotos: [], defects: "", reportId: makeReportId(), startedAt: new Date().toISOString(), cleaner };
}
function getSession(chatId: number): Session | null { return sessions.get(chatId) ?? null; }
function saveSession(chatId: number, session: Session): void { sessions.set(chatId, session); }
function clearSession(chatId: number): void { sessions.delete(chatId); }

function dateTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function dateLabel(iso: string): string { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso)); }
function timeOnly(iso: string): string { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
function durationLabel(startIso: string, endIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(endIso) - Date.parse(startIso)) / 1000));
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}
function cleanerLabel(user: TgUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return `${escapeHtml(user.username ? `@${user.username}` : "без username")} (${escapeHtml(name || "Без имени")})`;
}
function adminHeader(s: Session, phase: "ДО" | "ПОСЛЕ"): string {
  const timestamp = phase === "ДО" ? (s.beforeFinishedAt ?? new Date().toISOString()) : (s.afterFinishedAt ?? new Date().toISOString());
  return `🧹 <b>Новый статус уборки: ${phase}</b>\n👤 Клинер: ${cleanerLabel(s.cleaner)}\n📍 Объект: ${escapeHtml(s.objectName)} / ${escapeHtml(s.address)}\n🗓 Дата: ${dateLabel(timestamp)} ⏰ Время: ${timeOnly(timestamp)}\n🆔 Отчёт: <b>${escapeHtml(s.reportId)}</b>`;
}

async function adminText(tg: TelegramClient, env: Env, text: string): Promise<void> {
  const id = env.ADMIN_CHAT_ID?.trim();
  if (!id) { console.error("ADMIN_CHAT_ID is missing"); return; }
  try { await tg.sendMessage(Number(id), text); } catch (error) { console.error("Admin notification failed", error); }
}

async function adminMedia(tg: TelegramClient, env: Env, fileIds: string[], caption: string): Promise<void> {
  const id = env.ADMIN_CHAT_ID?.trim();
  if (!id || fileIds.length === 0) return;
  try {
    for (let offset = 0; offset < fileIds.length; offset += 10) {
      const chunk = fileIds.slice(offset, offset + 10);
      const media = chunk.map((fileId, index) => ({ type: "photo", media: fileId, ...(offset === 0 && index === 0 ? { caption, parse_mode: "HTML" } : {}) }));
      await tg.sendMediaGroup(Number(id), media);
    }
  } catch (error) {
    console.error("Admin media notification failed", error);
    await adminText(tg, env, `${caption}\n\n⚠️ Не удалось отправить медиагруппу.`);
  }
}

async function showMain(tg: TelegramClient, chatId: number, heading = "<b>House Cleaning</b>\n\nФотоотчёты по уборке объектов."): Promise<void> {
  await tg.sendMessage(chatId, `${heading}\n\nВыберите действие:`, MAIN_MENU);
}

async function startNewReport(tg: TelegramClient, chatId: number, user: TgUser): Promise<void> {
  saveSession(chatId, newSession(user));
  await tg.sendMessage(chatId, "<b>➕ Новый фотоотчёт</b>\n\n<b>Шаг 1 из 4 — Объект</b>\n\nВведите название или номер объекта.\n\n<i>Например: Объект №123</i>", CANCEL);
}

async function handleText(tg: TelegramClient, env: Env, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start") { clearSession(chatId); await showMain(tg, chatId, "<b>👋 Добро пожаловать в House Cleaning</b>"); return; }
  if (text === "/help") { await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU); return; }
  if (text === "/cancel") { clearSession(chatId); await showMain(tg, chatId, "<b>❌ Фотоотчёт отменён.</b>"); return; }

  const s = getSession(chatId);
  if (!s) { await showMain(tg, chatId); return; }

  if (s.state === "awaiting_object") {
    if (!text) { await tg.sendMessage(chatId, "Введите название или номер объекта текстом.", CANCEL); return; }
    s.objectName = text; s.state = "awaiting_address"; saveSession(chatId, s);
    await tg.sendMessage(chatId, `📍 <b>Шаг 2 из 4 — Адрес</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\n\nВведите полный адрес объекта.`, ADDRESS_MENU); return;
  }

  if (s.state === "awaiting_address") {
    if (!text) { await tg.sendMessage(chatId, "Введите адрес текстом.", ADDRESS_MENU); return; }
    s.address = text; s.state = "confirm_address"; saveSession(chatId, s);
    await tg.sendMessage(chatId, `📍 <b>Проверьте адрес</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\nАдрес: <b>${escapeHtml(s.address)}</b>\n\nВсё верно?`, CONFIRM_ADDRESS); return;
  }

  if (s.state === "awaiting_defects") {
    if (!text) { await tg.sendMessage(chatId, "Напишите описание дефекта текстом или выберите «Нет дефектов».", DEFECT_MENU); return; }
    s.defects = text; s.state = "after_photos"; saveSession(chatId, s);
    await adminText(tg, env, `⚠️ <b>Дефекты до уборки</b>\n\n${adminHeader(s, "ДО")}\n\n📝 Описание: ${escapeHtml(s.defects)}`);
    await tg.sendMessage(chatId, "📸 <b>Шаг 4 из 4 — Фото ПОСЛЕ</b>\n\nТеперь отправляйте фотографии результата уборки.", photoMenu("after")); return;
  }

  if (s.state === "before_photos" || s.state === "after_photos") {
    await tg.sendMessage(chatId, s.state === "before_photos" ? "📸 Сейчас ожидаются фотографии <b>ДО</b>. Отправьте фото или нажмите «Завершить ДО»." : "📸 Сейчас ожидаются фотографии <b>ПОСЛЕ</b>. Отправьте фото или нажмите «Завершить ПОСЛЕ».", photoMenu(s.state === "before_photos" ? "before" : "after")); return;
  }

  if (s.state === "confirm_finish") { await tg.sendMessage(chatId, "Выберите действие кнопками ниже.", CONFIRM_FINISH); return; }
  await showMain(tg, chatId);
}

async function handlePhoto(tg: TelegramClient, chatId: number, msg: TgMessage): Promise<void> {
  const s = getSession(chatId);
  const photo = msg.photo?.[msg.photo.length - 1];
  if (!photo) return;
  if (!s) { await tg.sendMessage(chatId, "Сначала создайте фотоотчёт.", MAIN_MENU); return; }

  if (s.state === "before_photos") {
    if (s.beforePhotos.length >= MAX_PHOTOS_PER_PHASE) { await tg.sendMessage(chatId, `⚠️ Максимум ${MAX_PHOTOS_PER_PHASE} фото ДО. Завершите этап ДО.`, photoMenu("before")); return; }
    s.beforePhotos.push(photo.file_id); saveSession(chatId, s);
    await tg.sendMessage(chatId, `✅ <b>Фото ДО получено</b>\n\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n\nОтправьте следующее фото или нажмите «Завершить ДО».`, photoMenu("before")); return;
  }

  if (s.state === "after_photos") {
    if (s.afterPhotos.length >= MAX_PHOTOS_PER_PHASE) { await tg.sendMessage(chatId, `⚠️ Максимум ${MAX_PHOTOS_PER_PHASE} фото ПОСЛЕ. Завершите этап ПОСЛЕ.`, photoMenu("after")); return; }
    s.afterPhotos.push(photo.file_id); saveSession(chatId, s);
    await tg.sendMessage(chatId, `✅ <b>Фото ПОСЛЕ получено</b>\n\n📸 Фото ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n\nОтправьте следующее фото или нажмите «Завершить ПОСЛЕ».`, photoMenu("after")); return;
  }

  await tg.sendMessage(chatId, "⚠️ Сейчас фотографии не ожидаются. Используйте кнопки текущего этапа.", MAIN_MENU);
}

async function handleCallback(tg: TelegramClient, env: Env, cq: TgCallbackQuery): Promise<void> {
  try { await tg.answerCallbackQuery(cq.id); } catch (error) { console.error("answerCallbackQuery failed", error); }
  const chatId = cq.message?.chat.id;
  if (!chatId) return;

  try {
    const data = cq.data ?? "";
    const s = getSession(chatId);

    if (data === "new_report") { await startNewReport(tg, chatId, cq.from); return; }
    if (data === "help") { await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU); return; }
    if (data === "my_reports") { await tg.sendMessage(chatId, "<b>🗂 Мои отчёты</b>\n\nИстория будет доступна после подключения постоянного хранилища. Сейчас данные живут только в памяти Worker.", MAIN_MENU); return; }
    if (data === "profile") { const name = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(" "); await tg.sendMessage(chatId, `👤 <b>Профиль</b>\n\nИмя: <b>${escapeHtml(name || "Без имени")}</b>\nUsername: <b>${escapeHtml(cq.from.username ? `@${cq.from.username}` : "не указан")}</b>\nTelegram ID: <code>${cq.from.id}</code>`, MAIN_MENU); return; }

    if (data === "cancel") {
      clearSession(chatId);
      if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
      await showMain(tg, chatId, "<b>❌ Фотоотчёт отменён.</b>"); return;
    }

    if (data === "back_object" && s?.state === "awaiting_address") {
      s.state = "awaiting_object"; s.address = ""; saveSession(chatId, s);
      await tg.sendMessage(chatId, "🔙 <b>Шаг 1 из 4 — Объект</b>\n\nВведите название или номер объекта.", CANCEL); return;
    }

    if (data === "edit_address" && s?.state === "confirm_address") {
      s.state = "awaiting_address"; saveSession(chatId, s);
      await tg.sendMessage(chatId, "✏️ Введите адрес ещё раз:", ADDRESS_MENU); return;
    }

    if (data === "address_ok" && s?.state === "confirm_address") {
      s.state = "before_photos"; saveSession(chatId, s);
      await tg.sendMessage(chatId, `📸 <b>Шаг 3 из 4 — Фото ДО</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\nАдрес: <b>${escapeHtml(s.address)}</b>\n\nОтправьте все необходимые фотографии ДО уборки.`, photoMenu("before")); return;
    }

    if (data === "finish_before" && s?.state === "before_photos") {
      if (s.beforePhotos.length < 1) { await tg.sendMessage(chatId, "⚠️ Сначала отправьте хотя бы одно фото ДО.", photoMenu("before")); return; }
      s.beforeFinishedAt = new Date().toISOString();
      s.state = "awaiting_defects";
      saveSession(chatId, s);
      if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
      await adminText(tg, env, `${adminHeader(s, "ДО")}\n\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>`);
      await adminMedia(tg, env, s.beforePhotos, `🧹 <b>Фото ДО — ${escapeHtml(s.reportId)}</b>`);
      await tg.sendMessage(chatId, "⚠️ <b>Проверка объекта до уборки</b>\n\nЕсть ли на объекте повреждения или дефекты до начала уборки?\n\nНапишите описание текстом или нажмите «Нет дефектов».", DEFECT_MENU); return;
    }

    if (data === "no_defects" && s?.state === "awaiting_defects") {
      s.defects = "Нет дефектов"; s.state = "after_photos"; saveSession(chatId, s);
      await adminText(tg, env, `⚠️ <b>Дефекты до уборки</b>\n\n${adminHeader(s, "ДО")}\n\n📝 <b>Нет дефектов</b>`);
      await tg.sendMessage(chatId, "📸 <b>Шаг 4 из 4 — Фото ПОСЛЕ</b>\n\nТеперь отправляйте фотографии результата уборки.", photoMenu("after")); return;
    }

    if (data === "finish_after" && s?.state === "after_photos") {
      if (s.afterPhotos.length < 1) { await tg.sendMessage(chatId, "⚠️ Сначала отправьте хотя бы одно фото ПОСЛЕ.", photoMenu("after")); return; }
      s.afterFinishedAt = new Date().toISOString(); s.state = "confirm_finish"; saveSession(chatId, s);
      if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
      await tg.sendMessage(chatId, `<b>📋 Проверьте фотоотчёт</b>\n\n🆔 Номер: <b>${escapeHtml(s.reportId)}</b>\n📍 Объект: <b>${escapeHtml(s.objectName)}</b>\nАдрес: <b>${escapeHtml(s.address)}</b>\n\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n📸 Фото ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "Не указаны")}</b>\n🕒 ДО: <b>${dateTimeLabel(s.beforeFinishedAt ?? s.startedAt)}</b>\n🕒 ПОСЛЕ: <b>${dateTimeLabel(s.afterFinishedAt)}</b>\n⏱ Время уборки: <b>${durationLabel(s.beforeFinishedAt ?? s.startedAt, s.afterFinishedAt)}</b>\n\n<b>Всё верно?</b>`, CONFIRM_FINISH); return;
    }

    if (data === "continue_after" && s?.state === "confirm_finish") {
      s.state = "after_photos"; s.afterFinishedAt = undefined; saveSession(chatId, s);
      await tg.sendMessage(chatId, "↩️ <b>Продолжаем этап ПОСЛЕ.</b>\n\nОтправляйте дополнительные фотографии.", photoMenu("after")); return;
    }

    if (data === "confirm_finish" && s?.state === "confirm_finish" && s.afterFinishedAt) {
      const duration = durationLabel(s.beforeFinishedAt ?? s.startedAt, s.afterFinishedAt);
      await adminText(tg, env, `${adminHeader(s, "ПОСЛЕ")}\n\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n📸 Фото ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "Не указаны")}</b>\n⏱ <b>Затраченное время на уборку: ${duration}</b>`);
      await adminMedia(tg, env, s.afterPhotos, `🧹 <b>Фото ПОСЛЕ — ${escapeHtml(s.reportId)}</b>`);

      const reportId = s.reportId, objectName = s.objectName, beforeCount = s.beforePhotos.length, afterCount = s.afterPhotos.length, finishedAt = s.afterFinishedAt;
      clearSession(chatId);
      if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
      await tg.sendMessage(chatId, `<b>✅ Фотоотчёт завершён</b>\n\n🆔 Номер: <b>${escapeHtml(reportId)}</b>\n📍 Объект: <b>${escapeHtml(objectName)}</b>\n📸 ДО: <b>${beforeCount}</b>\n📸 ПОСЛЕ: <b>${afterCount}</b>\n⏱ Время уборки: <b>${duration}</b>\n🗓 Завершён: <b>${dateTimeLabel(finishedAt)}</b>`, MAIN_MENU); return;
    }

    await tg.sendMessage(chatId, "⚠️ Эта кнопка больше не активна.", MAIN_MENU);
  } catch (error) {
    console.error("Callback handler failed", error);
    await tg.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте ещё раз или отправьте /start.", MAIN_MENU).catch(() => undefined);
  }
}

function rememberUpdate(updateId: number): boolean {
  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_PROCESSED_UPDATES) {
    const first = processedUpdates.values().next().value as number | undefined;
    if (first !== undefined) processedUpdates.delete(first);
  }
  return true;
}

function authorizedWebhook(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return !secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("House Cleaning Bot is running", { status: 200 });
    if (url.pathname !== "/webhook") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!authorizedWebhook(request, env)) return new Response("Forbidden", { status: 403 });

    let update: TgUpdate;
    try { update = (await request.json()) as TgUpdate; } catch { return new Response("Bad Request", { status: 400 }); }
    if (!update || typeof update.update_id !== "number" || !rememberUpdate(update.update_id)) return new Response("OK", { status: 200 });

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    try {
      if (update.callback_query) await handleCallback(tg, env, update.callback_query);
      else if (update.message?.photo) await handlePhoto(tg, update.message.chat.id, update.message);
      else if (update.message) await handleText(tg, env, update.message);
    } catch (error) {
      console.error("Update handler failed", error);
    }
    return new Response("OK", { status: 200 });
  },
};
