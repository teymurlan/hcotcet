export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_CHAT_ID: string;
  EMPLOYEE_IDS?: string;
}

type State =
  | "idle"
  | "awaiting_object"
  | "awaiting_address"
  | "confirm_address"
  | "awaiting_location"
  | "before_photos"
  | "awaiting_defects"
  | "after_photos"
  | "awaiting_expense_decision"
  | "awaiting_receipt"
  | "awaiting_expense_amount"
  | "confirm_finish";

interface TgUser { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string; }
interface TgPhoto { file_id: string; file_unique_id: string; width: number; height: number; }
interface TgLocation { latitude: number; longitude: number; horizontal_accuracy?: number; }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type?: string }; text?: string; photo?: TgPhoto[]; location?: TgLocation; }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string; }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; }
interface TgResult<T> { ok: boolean; result?: T; description?: string; }

interface Session {
  state: State;
  reportId: string;
  cleaner: TgUser;
  objectName: string;
  address: string;
  latitude?: number;
  longitude?: number;
  beforePhotos: string[];
  afterPhotos: string[];
  defects: string;
  expenseReceipt?: string;
  expenseAmount?: number;
  createdAt: string;
  beforeFinishedAt?: string;
  afterFinishedAt?: string;
  lastBotMessageId?: number;
  expiresAt: number;
}

interface CompletedReport {
  reportId: string;
  objectName: string;
  address: string;
  completedAt: string;
  beforeCount: number;
  afterCount: number;
  expense?: number;
}

const API = "https://api.telegram.org/bot";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_PHOTOS = 50;
const MAX_TEXT = 1500;
const MAX_HISTORY = 10;
const sessions = new Map<number, Session>();
const histories = new Map<number, CompletedReport[]>();
const processedUpdates = new Set<number>();

class Telegram {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const token = this.token.trim();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
    const response = await fetch(`${API}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let data: TgResult<T>;
    try { data = JSON.parse(body) as TgResult<T>; }
    catch { throw new Error(`Telegram ${method}: invalid JSON ${response.status}`); }
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    return data.result as T;
  }

  sendMessage(chatId: number, text: string, markup?: unknown, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
      ...extra,
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  editMessageReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
  }

  sendMediaGroup(chatId: number, media: unknown[]): Promise<TgMessage[]> {
    return this.call<TgMessage[]>("sendMediaGroup", { chat_id: chatId, media });
  }
}

const MAIN = {
  inline_keyboard: [
    [{ text: "🧹 Начать объект", callback_data: "new" }],
    [{ text: "🗂 Мои отчёты", callback_data: "history" }, { text: "👤 Профиль", callback_data: "profile" }],
    [{ text: "ℹ️ Помощь", callback_data: "help" }],
  ],
};
const CANCEL = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel" }]] };
const ADDRESS = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "back_object" }, { text: "❌ Отмена", callback_data: "cancel" }]] };
const ADDRESS_CONFIRM = {
  inline_keyboard: [
    [{ text: "✅ Адрес верный", callback_data: "address_ok" }],
    [{ text: "✏️ Изменить", callback_data: "edit_address" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const DEFECTS = {
  inline_keyboard: [
    [{ text: "✅ Всё цело", callback_data: "no_defects" }],
    [{ text: "✏️ Указать дефекты", callback_data: "write_defects" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const EXPENSES = {
  inline_keyboard: [
    [{ text: "💸 Да, добавить чек", callback_data: "expense_yes" }],
    [{ text: "✅ Нет расходов", callback_data: "expense_no" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const FINISH = {
  inline_keyboard: [
    [{ text: "🏁 Подтвердить отчёт", callback_data: "finish_confirm" }],
    [{ text: "↩️ Вернуться к фото", callback_data: "continue_after" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const LOCATION = {
  keyboard: [[{ text: "📍 Отправить геопозицию", request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const REMOVE_KEYBOARD = { remove_keyboard: true };

function photoMenu(phase: "before" | "after") {
  return {
    inline_keyboard: [
      [{ text: phase === "before" ? "✅ Завершить загрузку ДО" : "🏁 Завершить загрузку ПОСЛЕ", callback_data: phase === "before" ? "finish_before" : "finish_after" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }],
    ],
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function textOf(value: string): string { return value.trim().slice(0, MAX_TEXT); }
function now(): string { return new Date().toISOString(); }
function makeReportId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return `HC-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}
function moscow(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}
function elapsed(start: string, end: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 60000));
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
function cleanerName(user: TgUser): string {
  return `${user.username ? `@${user.username}` : `ID ${user.id}`} (${[user.first_name, user.last_name].filter(Boolean).join(" ") || "Без имени"})`;
}
function mapsLink(s: Session): string {
  return s.latitude === undefined || s.longitude === undefined ? "" : `https://www.google.com/maps?q=${s.latitude},${s.longitude}`;
}
function getSession(chatId: number): Session | undefined {
  const s = sessions.get(chatId);
  if (!s) return undefined;
  if (s.expiresAt <= Date.now()) { sessions.delete(chatId); return undefined; }
  return s;
}
function saveSession(chatId: number, s: Session): void {
  s.expiresAt = Date.now() + SESSION_TTL;
  sessions.set(chatId, s);
}
function clearSession(chatId: number): void { sessions.delete(chatId); }
function isEmployee(env: Env, userId: number): boolean {
  const adminId = Number(env.ADMIN_CHAT_ID?.trim());
  if (Number.isFinite(adminId) && userId === adminId) return true;
  return (env.EMPLOYEE_IDS ?? "").split(",").map((x) => Number(x.trim())).filter(Number.isFinite).includes(userId);
}
function statusText(s: Session): string {
  const expense = s.expenseAmount === undefined ? "не указаны" : `${s.expenseAmount.toFixed(2)} ₽`;
  return `<b>📋 ${escapeHtml(s.reportId)}</b>\n\n📍 ${escapeHtml(s.objectName)}\n🏠 ${escapeHtml(s.address)}\n📸 ДО: <b>${s.beforePhotos.length}</b> | ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "не указаны")}</b>\n💸 Расходы: <b>${escapeHtml(expense)}</b>\n\n<b>Текущий этап:</b> ${escapeHtml(s.state)}`;
}
function startAdminText(s: Session): string {
  const map = mapsLink(s);
  return `🚀 <b>СТАРТ УБОРКИ</b>\n\n👤 Клинер: ${escapeHtml(cleanerName(s.cleaner))}\n📍 Объект: <b>${escapeHtml(s.objectName)}</b>\n🏠 Адрес: <b>${escapeHtml(s.address)}</b>\n🗓 ${moscow(s.beforeFinishedAt ?? now())}\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n${map ? `🗺 <a href="${map}">Открыть геопозицию</a>\n` : ""}🆔 <code>${escapeHtml(s.reportId)}</code>`;
}
function finalAdminText(s: Session): string {
  const end = s.afterFinishedAt ?? now();
  const expense = s.expenseAmount === undefined ? "Нет" : `${s.expenseAmount.toFixed(2)} ₽`;
  return `🏁 <b>УБОРКА ЗАВЕРШЕНА</b>\n\n👤 Клинер: ${escapeHtml(cleanerName(s.cleaner))}\n📍 Объект: <b>${escapeHtml(s.objectName)}</b>\n🏠 Адрес: <b>${escapeHtml(s.address)}</b>\n🗓 ${moscow(end)}\n⏱ Затрачено времени: <b>${elapsed(s.beforeFinishedAt ?? s.createdAt, end)}</b>\n📸 ДО: <b>${s.beforePhotos.length}</b> | ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "Нет")}</b>\n💸 Расходы: <b>${escapeHtml(expense)}</b>\n🆔 <code>${escapeHtml(s.reportId)}</code>`;
}

async function safeDelete(tg: Telegram, chatId: number, messageId?: number): Promise<void> {
  if (!messageId) return;
  try { await tg.deleteMessage(chatId, messageId); } catch {}
}
async function replaceStep(tg: Telegram, chatId: number, s: Session, text: string, markup?: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  await safeDelete(tg, chatId, s.lastBotMessageId);
  const sent = await tg.sendMessage(chatId, text, markup, extra);
  s.lastBotMessageId = sent.message_id;
  saveSession(chatId, s);
}
async function adminMessage(tg: Telegram, env: Env, text: string, markup?: unknown): Promise<void> {
  const adminId = Number(env.ADMIN_CHAT_ID?.trim());
  if (!Number.isFinite(adminId)) return;
  try { await tg.sendMessage(adminId, text, markup); } catch (error) { console.error("adminMessage", error); }
}
async function adminMedia(tg: Telegram, env: Env, ids: string[], caption: string): Promise<void> {
  const adminId = Number(env.ADMIN_CHAT_ID?.trim());
  if (!Number.isFinite(adminId) || ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const media = chunk.map((id, j) => ({ type: "photo", media: id, ...(i === 0 && j === 0 ? { caption, parse_mode: "HTML" } : {}) }));
    try { await tg.sendMediaGroup(adminId, media); } catch (error) { console.error("adminMedia", error); }
  }
}
async function mainMenu(tg: Telegram, chatId: number, title = "<b>👋 House Cleaning</b>\n\nФотоотчёты по объектам."): Promise<void> {
  await tg.sendMessage(chatId, `${title}\n\nВыберите действие:`, MAIN);
}
async function startNewReport(tg: Telegram, chatId: number, user: TgUser): Promise<void> {
  const old = getSession(chatId);
  if (old) await safeDelete(tg, chatId, old.lastBotMessageId);
  const s: Session = {
    state: "awaiting_object", reportId: makeReportId(), cleaner: user, objectName: "", address: "",
    beforePhotos: [], afterPhotos: [], defects: "", createdAt: now(), expiresAt: Date.now() + SESSION_TTL,
  };
  saveSession(chatId, s);
  await replaceStep(tg, chatId, s, `<b>🧹 Новый объект</b>\n\n<b>Шаг 1 из 7 — Объект</b>\n\nВведите название или номер объекта.\n<i>Например: Объект №123</i>`, CANCEL);
}

async function handleText(tg: Telegram, env: Env, msg: TgMessage): Promise<void> {
  const user = msg.from;
  if (!user) return;
  const chatId = msg.chat.id;
  const text = textOf(msg.text ?? "");
  if (!isEmployee(env, user.id)) {
    if (text === "/start") await tg.sendMessage(chatId, "⛔ <b>Доступ закрыт.</b>\n\nБот доступен только сотрудникам House Cleaning.");
    return;
  }

  const current = getSession(chatId);
  if (text === "/start" || text === "/menu") {
    if (current) await safeDelete(tg, chatId, current.lastBotMessageId);
    clearSession(chatId);
    await mainMenu(tg, chatId);
    await safeDelete(tg, chatId, msg.message_id);
    return;
  }
  if (text === "/new") { await startNewReport(tg, chatId, user); await safeDelete(tg, chatId, msg.message_id); return; }
  if (text === "/help") { if (current) await safeDelete(tg, chatId, current.lastBotMessageId); await mainMenu(tg, chatId, `<b>ℹ️ Помощь</b>\n\n<b>Команды:</b> /start — меню\n/new — новый объект\n/status — текущий отчёт\n/cancel — отмена\n/help — помощь\n\nПорядок: объект → адрес → геопозиция → фото ДО → дефекты → фото ПОСЛЕ → расходы → подтверждение.`); await safeDelete(tg, chatId, msg.message_id); return; }
  if (text === "/cancel") { if (current) await safeDelete(tg, chatId, current.lastBotMessageId); clearSession(chatId); await mainMenu(tg, chatId, "<b>❌ Отчёт отменён.</b>"); await safeDelete(tg, chatId, msg.message_id); return; }
  if (text === "/status") { if (!current) await mainMenu(tg, chatId, "<b>ℹ️ Активного отчёта нет.</b>"); else await mainMenu(tg, chatId, statusText(current)); await safeDelete(tg, chatId, msg.message_id); return; }

  const s = getSession(chatId);
  if (!s) { await mainMenu(tg, chatId, "<b>Начнём?</b>"); await safeDelete(tg, chatId, msg.message_id); return; }

  switch (s.state) {
    case "awaiting_object":
      if (text) { s.objectName = text; s.state = "awaiting_address"; await replaceStep(tg, chatId, s, `<b>📍 Шаг 2 из 7 — Адрес</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\n\nВведите полный адрес.`, ADDRESS); }
      break;
    case "awaiting_address":
      if (text) { s.address = text; s.state = "confirm_address"; await replaceStep(tg, chatId, s, `<b>📍 Проверьте адрес</b>\n\n<b>${escapeHtml(s.objectName)}</b>\n${escapeHtml(s.address)}\n\nАдрес указан верно?`, ADDRESS_CONFIRM); }
      break;
    case "awaiting_defects":
      if (text) {
        s.defects = text;
        s.state = "after_photos";
        await adminMessage(tg, env, `⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 ${escapeHtml(text)}`);
        await replaceStep(tg, chatId, s, `<b>📸 Шаг 5 из 7 — Фото ПОСЛЕ</b>\n\nОтправляйте фото результата.\n\nФото ПОСЛЕ: <b>0</b>`, photoMenu("after"));
      }
      break;
    case "awaiting_expense_amount": {
      const amount = Number(text.replace(/\s/g, "").replace("₽", "").replace(",", "."));
      if (Number.isFinite(amount) && amount > 0 && amount <= 100000) {
        s.expenseAmount = Math.round(amount * 100) / 100;
        s.state = "confirm_finish";
        await replaceStep(tg, chatId, s, `<b>📋 Шаг 7 из 7 — Проверка</b>\n\n${statusText(s)}\n\n<b>Всё верно?</b>`, FINISH);
      } else {
        await replaceStep(tg, chatId, s, `Введите сумму числом, например <b>850</b>.`, CANCEL);
      }
      break;
    }
    default:
      await replaceStep(tg, chatId, s, `⚠️ Сейчас ожидается другое действие. Используйте кнопку текущего шага или /cancel.`, CANCEL);
  }
  await safeDelete(tg, chatId, msg.message_id);
}

async function handleLocation(tg: Telegram, chatId: number, msg: TgMessage): Promise<void> {
  const s = getSession(chatId);
  if (!s || s.state !== "awaiting_location" || !msg.location) return;
  s.latitude = msg.location.latitude;
  s.longitude = msg.location.longitude;
  s.state = "before_photos";
  await safeDelete(tg, chatId, s.lastBotMessageId);
  const sent = await tg.sendMessage(chatId, `<b>📸 Шаг 4 из 7 — Фото ДО</b>\n\n📍 Геопозиция получена ✅\n\nОтправьте фотографии объекта ДО уборки.\n\nФото ДО: <b>0</b>`, photoMenu("before"), { reply_markup: REMOVE_KEYBOARD });
  s.lastBotMessageId = sent.message_id;
  saveSession(chatId, s);
  await safeDelete(tg, chatId, msg.message_id);
}

async function handlePhoto(tg: Telegram, chatId: number, msg: TgMessage): Promise<void> {
  const s = getSession(chatId);
  const photo = msg.photo?.at(-1);
  if (!s || !photo) return;

  switch (s.state) {
    case "before_photos":
      if (s.beforePhotos.length >= MAX_PHOTOS) { await replaceStep(tg, chatId, s, `⚠️ Лимит ${MAX_PHOTOS} фото ДО.`, photoMenu("before")); break; }
      s.beforePhotos.push(photo.file_id);
      await replaceStep(tg, chatId, s, `✅ <b>Фото ДО принято</b>\n\nФото ДО: <b>${s.beforePhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`, photoMenu("before"));
      break;
    case "after_photos":
      if (s.afterPhotos.length >= MAX_PHOTOS) { await replaceStep(tg, chatId, s, `⚠️ Лимит ${MAX_PHOTOS} фото ПОСЛЕ.`, photoMenu("after")); break; }
      s.afterPhotos.push(photo.file_id);
      await replaceStep(tg, chatId, s, `✅ <b>Фото ПОСЛЕ принято</b>\n\nФото ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`, photoMenu("after"));
      break;
    case "awaiting_receipt":
      s.expenseReceipt = photo.file_id;
      s.state = "awaiting_expense_amount";
      await replaceStep(tg, chatId, s, `<b>🧾 Чек принят</b>\n\nВведите сумму расхода, например <b>850</b>.`, CANCEL);
      break;
    default:
      await replaceStep(tg, chatId, s, `⚠️ Фото сейчас не ожидается. Используйте кнопку текущего шага.`, CANCEL);
  }
  await safeDelete(tg, chatId, msg.message_id);
}

async function handleCallback(tg: Telegram, env: Env, cq: TgCallback): Promise<void> {
  try { await tg.answerCallbackQuery(cq.id); } catch (error) { console.error("answerCallbackQuery", error); }
  const chatId = cq.message?.chat.id;
  if (!chatId || !isEmployee(env, cq.from.id)) return;
  const data = cq.data ?? "";
  const s = getSession(chatId);

  try {
    switch (data) {
      case "new":
        await startNewReport(tg, chatId, cq.from);
        return;
      case "help":
        if (s) await safeDelete(tg, chatId, s.lastBotMessageId);
        await mainMenu(tg, chatId, `<b>ℹ️ Помощь</b>\n\n<b>Быстрые команды:</b> /start /new /status /cancel /help\n\nПорядок: объект → адрес → геопозиция → ДО → дефекты → ПОСЛЕ → расходы → подтверждение.`);
        return;
      case "history": {
        const history = histories.get(cq.from.id) ?? [];
        if (!history.length) { await mainMenu(tg, chatId, `<b>🗂 Мои отчёты</b>\n\nИстория пока пуста.`); return; }
        const lines = history.map((r, i) => `${i + 1}. <b>${escapeHtml(r.reportId)}</b> — ${escapeHtml(r.objectName)}\n   ${escapeHtml(r.completedAt)} · ДО ${r.beforeCount} · ПОСЛЕ ${r.afterCount}${r.expense === undefined ? "" : ` · ${r.expense.toFixed(2)} ₽`}`);
        await mainMenu(tg, chatId, `<b>🗂 Мои отчёты</b>\n\n${lines.join("\n\n")}`);
        return;
      }
      case "profile":
        await mainMenu(tg, chatId, `<b>👤 Профиль</b>\n\nИмя: <b>${escapeHtml([cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") || "Без имени")}</b>\nUsername: <b>${escapeHtml(cq.from.username ? `@${cq.from.username}` : "не указан")}</b>\nID: <code>${cq.from.id}</code>`);
        return;
      case "cancel":
        if (s) await safeDelete(tg, chatId, s.lastBotMessageId);
        clearSession(chatId);
        await mainMenu(tg, chatId, "<b>❌ Отчёт отменён.</b>");
        return;
      case "back_object":
        if (s?.state === "awaiting_address") { s.state = "awaiting_object"; await replaceStep(tg, chatId, s, `<b>🔙 Шаг 1 из 7 — Объект</b>\n\nВведите название или номер объекта.`, CANCEL); }
        return;
      case "edit_address":
        if (s?.state === "confirm_address") { s.state = "awaiting_address"; await replaceStep(tg, chatId, s, `<b>✏️ Шаг 2 из 7 — Адрес</b>\n\nВведите адрес ещё раз.`, ADDRESS); }
        return;
      case "address_ok":
        if (s?.state === "confirm_address") {
          s.state = "awaiting_location";
          await safeDelete(tg, chatId, s.lastBotMessageId);
          const sent = await tg.sendMessage(chatId, `<b>📍 Шаг 3 из 7 — Геопозиция</b>\n\nАдрес: <b>${escapeHtml(s.address)}</b>\n\nНажмите кнопку ниже и отправьте текущую геопозицию.`, undefined, { reply_markup: LOCATION });
          s.lastBotMessageId = sent.message_id;
          saveSession(chatId, s);
        }
        return;
      case "finish_before":
        if (s?.state !== "before_photos") return;
        if (!s.beforePhotos.length) { await replaceStep(tg, chatId, s, `⚠️ Сначала отправьте хотя бы одно фото ДО.`, photoMenu("before")); return; }
        s.beforeFinishedAt = now();
        s.state = "awaiting_defects";
        saveSession(chatId, s);
        await adminMessage(tg, env, startAdminText(s));
        await adminMedia(tg, env, s.beforePhotos, `🚀 <b>Фото ДО · ${escapeHtml(s.reportId)}</b>`);
        await replaceStep(tg, chatId, s, `<b>⚠️ Шаг 5 из 7 — Дефекты</b>\n\nЕсть ли повреждения или дефекты ДО уборки?`, DEFECTS);
        return;
      case "no_defects":
        if (s?.state !== "awaiting_defects") return;
        s.defects = "Нет дефектов";
        s.state = "after_photos";
        await adminMessage(tg, env, `⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 <b>Нет дефектов</b>`);
        await replaceStep(tg, chatId, s, `<b>📸 Шаг 5 из 7 — Фото ПОСЛЕ</b>\n\nОтправляйте фото результата.\n\nФото ПОСЛЕ: <b>0</b>`, photoMenu("after"));
        return;
      case "write_defects":
        if (s?.state !== "awaiting_defects") return;
        await replaceStep(tg, chatId, s, `<b>✏️ Опишите дефекты</b>\n\nНапишите одним сообщением, что было повреждено или уже имело дефект до уборки.`, CANCEL);
        return;
      case "finish_after":
        if (s?.state !== "after_photos") return;
        if (!s.afterPhotos.length) { await replaceStep(tg, chatId, s, `⚠️ Сначала отправьте хотя бы одно фото ПОСЛЕ.`, photoMenu("after")); return; }
        s.afterFinishedAt = now();
        s.state = "awaiting_expense_decision";
        await replaceStep(tg, chatId, s, `<b>💸 Шаг 6 из 7 — Расходы</b>\n\nБыли расходы на химию, такси или другие нужды?`, EXPENSES);
        return;
      case "expense_yes":
        if (s?.state !== "awaiting_expense_decision") return;
        s.state = "awaiting_receipt";
        await replaceStep(tg, chatId, s, `<b>🧾 Фото чека</b>\n\nПришлите фото чека. После него бот попросит сумму.`, CANCEL);
        return;
      case "expense_no":
        if (s?.state !== "awaiting_expense_decision") return;
        s.expenseAmount = undefined;
        s.state = "confirm_finish";
        await replaceStep(tg, chatId, s, `<b>📋 Шаг 7 из 7 — Проверка</b>\n\n${statusText(s)}\n\n<b>Всё верно?</b>`, FINISH);
        return;
      case "continue_after":
        if (s?.state !== "confirm_finish") return;
        s.state = "after_photos";
        s.afterFinishedAt = undefined;
        await replaceStep(tg, chatId, s, `<b>📸 Фото ПОСЛЕ</b>\n\nФото ПОСЛЕ: <b>${s.afterPhotos.length}</b>`, photoMenu("after"));
        return;
      case "finish_confirm":
        if (s?.state !== "confirm_finish") return;
        if (!s.beforePhotos.length || !s.afterPhotos.length) { await replaceStep(tg, chatId, s, `⚠️ Нельзя завершить отчёт без фото ДО и ПОСЛЕ.`, FINISH); return; }
        s.afterFinishedAt = s.afterFinishedAt ?? now();
        await adminMessage(tg, env, finalAdminText(s), {
          inline_keyboard: [
            [{ text: "✅ Принять отчёт", callback_data: `accept:${s.reportId}` }],
            [{ text: "⚠️ Связаться с клинером", callback_data: `contact:${s.cleaner.id}` }],
          ],
        });
        await adminMedia(tg, env, s.afterPhotos, `🏁 <b>Фото ПОСЛЕ · ${escapeHtml(s.reportId)}</b>`);
        if (s.expenseReceipt) await adminMedia(tg, env, [s.expenseReceipt], `🧾 <b>Чек · ${escapeHtml(s.reportId)}</b>`);
        const history = histories.get(s.cleaner.id) ?? [];
        history.unshift({ reportId: s.reportId, objectName: s.objectName, address: s.address, completedAt: moscow(s.afterFinishedAt), beforeCount: s.beforePhotos.length, afterCount: s.afterPhotos.length, expense: s.expenseAmount });
        histories.set(s.cleaner.id, history.slice(0, MAX_HISTORY));
        await safeDelete(tg, chatId, s.lastBotMessageId);
        clearSession(chatId);
        await mainMenu(tg, chatId, `<b>🏁 Отчёт отправлен администратору.</b>\n\nНомер: <code>${escapeHtml(s.reportId)}</code>`);
        return;
      default:
        if (data === "noop") return;
        if (data.startsWith("accept:") && chatId === Number(env.ADMIN_CHAT_ID?.trim())) {
          if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id, { inline_keyboard: [[{ text: "Принято ✅", callback_data: "noop" }]] });
          return;
        }
        if (data.startsWith("contact:") && chatId === Number(env.ADMIN_CHAT_ID?.trim())) {
          const userId = Number(data.split(":")[1]);
          if (Number.isFinite(userId)) await tg.sendMessage(chatId, `⚠️ <b>Связаться с клинером</b>\n\nID: <code>${userId}</code>`, { inline_keyboard: [[{ text: "💬 Открыть профиль", url: `tg://user?id=${userId}` }]] });
        }
    }
  } catch (error) {
    console.error("callback handler", error);
    try { await tg.sendMessage(chatId, "⚠️ Не удалось выполнить действие. Нажмите /start и повторите."); } catch {}
  }
}

function alreadyProcessed(updateId: number): boolean {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 5000) {
    const first = processedUpdates.values().next().value;
    if (typeof first === "number") processedUpdates.delete(first);
  }
  return false;
}
function validWebhook(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return !secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("House Cleaning bot is running", { status: 200 });
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, worker: "hcotcet" });
    if (url.pathname !== "/webhook") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!validWebhook(request, env)) return new Response("Forbidden", { status: 403 });

    let update: TgUpdate;
    try { update = await request.json() as TgUpdate; } catch { return new Response("Bad Request", { status: 400 }); }
    if (!update || typeof update.update_id !== "number") return new Response("Bad Request", { status: 400 });
    if (alreadyProcessed(update.update_id)) return new Response("OK", { status: 200 });

    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    try {
      if (update.callback_query) {
        await handleCallback(tg, env, update.callback_query);
      } else if (update.message?.from && isEmployee(env, update.message.from.id)) {
        if (update.message.location) await handleLocation(tg, update.message.chat.id, update.message);
        else if (update.message.photo?.length) await handlePhoto(tg, update.message.chat.id, update.message);
        else if (update.message.text !== undefined) await handleText(tg, env, update.message);
      } else if (update.message?.text !== undefined) {
        await handleText(tg, env, update.message);
      }
    } catch (error) {
      console.error("webhook processing", error);
    }
    return new Response("OK", { status: 200 });
  },
};
