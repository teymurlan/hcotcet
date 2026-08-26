export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_CHAT_ID: string;
  // Comma-separated Telegram user IDs allowed to use the bot.
  // Example: "835372319,123456789"
  EMPLOYEE_IDS?: string;
}

type State =
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

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
}

interface TgLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type?: string };
  text?: string;
  photo?: TgPhotoSize[];
  location?: TgLocation;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

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
  startedAt: string;
  beforeFinishedAt?: string;
  afterFinishedAt?: string;
  lastBotMessageId?: number;
  expiresAt: number;
}

interface TelegramResult<T> { ok: boolean; result?: T; description?: string; }

const TELEGRAM_API = "https://api.telegram.org/bot";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PHOTOS = 50;
const MAX_TEXT = 1500;
const sessions = new Map<number, Session>();
const processedUpdates = new Set<number>();

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
    let data: TelegramResult<T>;
    try { data = JSON.parse(body) as TelegramResult<T>; }
    catch { throw new Error(`Telegram ${method}: invalid JSON ${response.status}`); }
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    return data.result as T;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<void> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string): Promise<void> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }

  editMessageReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<void> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
  }

  sendMediaGroup(chatId: number, media: unknown[]): Promise<TgMessage[]> {
    return this.call<TgMessage[]>("sendMediaGroup", { chat_id: chatId, media });
  }
}

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "🧹 Начать объект", callback_data: "new_report" }],
    [{ text: "🗂 Мои отчёты", callback_data: "my_reports" }, { text: "👤 Профиль", callback_data: "profile" }],
    [{ text: "ℹ️ Помощь", callback_data: "help" }],
  ],
};

const CANCEL = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel" }]] };
const ADDRESS_MENU = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "back_object" }, { text: "❌ Отмена", callback_data: "cancel" }]] };
const CONFIRM_ADDRESS = {
  inline_keyboard: [
    [{ text: "✅ Адрес верный", callback_data: "address_ok" }],
    [{ text: "✏️ Изменить", callback_data: "edit_address" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const DEFECT_MENU = {
  inline_keyboard: [
    [{ text: "✅ Всё цело", callback_data: "no_defects" }],
    [{ text: "✏️ Указать дефекты", callback_data: "write_defects" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const EXPENSE_MENU = {
  inline_keyboard: [
    [{ text: "💸 Да, добавить чек", callback_data: "expense_yes" }],
    [{ text: "✅ Нет расходов", callback_data: "expense_no" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};
const FINISH_MENU = {
  inline_keyboard: [
    [{ text: "🏁 Подтвердить отчёт", callback_data: "confirm_finish" }],
    [{ text: "↩️ Вернуться к фото", callback_data: "continue_after" }],
    [{ text: "❌ Отмена", callback_data: "cancel" }],
  ],
};

function photoMenu(phase: "before" | "after") {
  return {
    inline_keyboard: [
      [{ text: phase === "before" ? "✅ Завершить загрузку ДО" : "🏁 Завершить загрузку ПОСЛЕ", callback_data: phase === "before" ? "finish_before" : "finish_after" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }],
    ],
  };
}

const LOCATION_KEYBOARD = {
  keyboard: [[{ text: "📍 Отправить мою геопозицию", request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const REMOVE_KEYBOARD = { remove_keyboard: true };

const HELP_TEXT = `<b>ℹ️ House Cleaning — Фотоотчёты</b>\n\n` +
  `<b>Быстрые команды:</b>\n/start — главное меню\n/new — новый объект\n/status — текущий отчёт\n/cancel — отменить\n/help — помощь\n\n` +
  `<b>Порядок работы:</b>\n1️⃣ Объект\n2️⃣ Адрес\n3️⃣ Геопозиция\n4️⃣ Фото ДО\n5️⃣ Дефекты\n6️⃣ Фото ПОСЛЕ\n7️⃣ Расходы\n8️⃣ Подтверждение\n\n` +
  `Бот показывает только актуальный шаг и автоматически считает фото и время уборки.`;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function textOf(value: string): string { return value.trim().slice(0, MAX_TEXT); }

function makeReportId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `HC-${code}`;
}

function newSession(cleaner: TgUser): Session {
  return {
    state: "awaiting_object",
    reportId: makeReportId(),
    cleaner,
    objectName: "",
    address: "",
    beforePhotos: [],
    afterPhotos: [],
    defects: "",
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

function getSession(chatId: number): Session | null {
  const s = sessions.get(chatId);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(chatId); return null; }
  return s;
}

function saveSession(chatId: number, s: Session): void {
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(chatId, s);
}

function clearSession(chatId: number): void { sessions.delete(chatId); }

function isEmployee(env: Env, userId: number): boolean {
  const adminId = Number(env.ADMIN_CHAT_ID?.trim());
  if (Number.isFinite(adminId) && userId === adminId) return true;
  const ids = (env.EMPLOYEE_IDS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  return ids.includes(userId);
}

function moscow(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(d),
    time: new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(d),
  };
}

function duration(start: string, end: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

function cleanerLabel(u: TgUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Без имени";
  return `${escapeHtml(u.username ? `@${u.username}` : `ID ${u.id}`)} (${escapeHtml(name)})`;
}

function mapsLink(s: Session): string {
  if (s.latitude === undefined || s.longitude === undefined) return "";
  return `https://www.google.com/maps?q=${encodeURIComponent(`${s.latitude},${s.longitude}`)}`;
}

function startAdminText(s: Session): string {
  const when = moscow(s.beforeFinishedAt ?? new Date().toISOString());
  const map = mapsLink(s);
  return `🚀 <b>СТАРТ УБОРКИ</b>\n\n` +
    `👤 Клинер: ${cleanerLabel(s.cleaner)}\n` +
    `📍 Объект: <b>${escapeHtml(s.objectName)}</b>\n` +
    `🏠 Адрес: <b>${escapeHtml(s.address)}</b>\n` +
    `🗓 ${when.date} ⏰ ${when.time}\n` +
    `📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n` +
    (map ? `🗺 <a href="${map}">Открыть геопозицию</a>\n` : "") +
    `🆔 Отчёт: <code>${escapeHtml(s.reportId)}</code>`;
}

function summary(s: Session): string {
  const expenses = s.expenseAmount === undefined ? "Нет" : `${s.expenseAmount.toFixed(2)} ₽`;
  return `🆔 <b>${escapeHtml(s.reportId)}</b>\n` +
    `📍 <b>${escapeHtml(s.objectName)}</b>\n` +
    `🏠 ${escapeHtml(s.address)}\n` +
    `📸 ДО: <b>${s.beforePhotos.length}</b> | ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n` +
    `⚠️ Дефекты: <b>${escapeHtml(s.defects || "Нет")}</b>\n` +
    `💸 Расходы: <b>${escapeHtml(expenses)}</b>`;
}

function finalAdminText(s: Session): string {
  const end = s.afterFinishedAt ?? new Date().toISOString();
  const expenses = s.expenseAmount === undefined ? "Нет" : `${s.expenseAmount.toFixed(2)} ₽`;
  return `🏁 <b>УБОРКА ЗАВЕРШЕНА</b>\n\n` +
    `👤 Клинер: ${cleanerLabel(s.cleaner)}\n` +
    `📍 Объект: <b>${escapeHtml(s.objectName)}</b>\n` +
    `🏠 Адрес: <b>${escapeHtml(s.address)}</b>\n` +
    `🗓 ${moscow(end).date} ⏰ ${moscow(end).time}\n` +
    `⏱ Затрачено времени: <b>${duration(s.beforeFinishedAt ?? s.startedAt, end)}</b>\n` +
    `📸 ДО: <b>${s.beforePhotos.length}</b> | ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n` +
    `⚠️ Дефекты: <b>${escapeHtml(s.defects || "Нет")}</b>\n` +
    `💸 Расходы: <b>${escapeHtml(expenses)}</b>\n` +
    `🆔 Отчёт: <code>${escapeHtml(s.reportId)}</code>`;
}

async function safeDelete(tg: TelegramClient, chatId: number, messageId?: number): Promise<void> {
  if (!messageId) return;
  try { await tg.deleteMessage(chatId, messageId); } catch { /* deletion is best-effort */ }
}

async function replaceStep(tg: TelegramClient, chatId: number, s: Session, text: string, markup?: unknown): Promise<void> {
  await safeDelete(tg, chatId, s.lastBotMessageId);
  const m = await tg.sendMessage(chatId, text, markup);
  s.lastBotMessageId = m.message_id;
  saveSession(chatId, s);
}

async function adminText(tg: TelegramClient, env: Env, text: string, markup?: unknown): Promise<void> {
  const admin = Number(env.ADMIN_CHAT_ID?.trim());
  if (!Number.isFinite(admin)) { console.error("Invalid ADMIN_CHAT_ID"); return; }
  try { await tg.sendMessage(admin, text, markup); }
  catch (error) { console.error("Admin message failed", error); }
}

async function adminMedia(tg: TelegramClient, env: Env, fileIds: string[], caption: string): Promise<void> {
  const admin = Number(env.ADMIN_CHAT_ID?.trim());
  if (!Number.isFinite(admin) || fileIds.length === 0) return;
  for (let i = 0; i < fileIds.length; i += 10) {
    const chunk = fileIds.slice(i, i + 10);
    const media = chunk.map((fileId, index) => ({
      type: "photo",
      media: fileId,
      ...(i === 0 && index === 0 ? { caption, parse_mode: "HTML" } : {}),
    }));
    try { await tg.sendMediaGroup(admin, media); }
    catch (error) { console.error("Admin media failed", error); }
  }
}

async function mainMenu(tg: TelegramClient, chatId: number, title = "<b>👋 House Cleaning</b>\n\nФотоотчёты по объектам."): Promise<void> {
  await tg.sendMessage(chatId, `${title}\n\nВыберите действие:`, MAIN_MENU);
}

async function startNewReport(tg: TelegramClient, chatId: number, user: TgUser): Promise<void> {
  const old = getSession(chatId);
  if (old) await safeDelete(tg, chatId, old.lastBotMessageId);
  const s = newSession(user);
  saveSession(chatId, s);
  await replaceStep(tg, chatId, s,
    `<b>🧹 Новый объект</b>\n\n<b>Шаг 1 из 7 — Объект</b>\n\nВведите название или номер объекта.\n<i>Например: Объект №123</i>`, CANCEL);
}

async function toAfterPhotos(tg: TelegramClient, chatId: number, s: Session): Promise<void> {
  s.state = "after_photos";
  await replaceStep(tg, chatId, s,
    `<b>📸 Шаг 5 из 7 — Фото ПОСЛЕ</b>\n\nОтправляйте фотографии результата.\n\nФото ПОСЛЕ: <b>${s.afterPhotos.length}</b>`, photoMenu("after"));
}

async function handleText(tg: TelegramClient, env: Env, msg: TgMessage): Promise<void> {
  const user = msg.from;
  if (!user) return;
  const chatId = msg.chat.id;
  const text = textOf(msg.text ?? "");

  if (!isEmployee(env, user.id)) {
    if (text === "/start") await tg.sendMessage(chatId, "⛔ <b>Доступ ограничен.</b>\n\nБот доступен только сотрудникам House Cleaning.");
    return;
  }

  if (text === "/start" || text === "/menu") {
    const old = getSession(chatId);
    if (old) await safeDelete(tg, chatId, old.lastBotMessageId);
    clearSession(chatId);
    await mainMenu(tg, chatId);
    return;
  }
  if (text === "/new") { await startNewReport(tg, chatId, user); return; }
  if (text === "/help") { await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU); return; }
  if (text === "/cancel") {
    const old = getSession(chatId);
    if (old) await safeDelete(tg, chatId, old.lastBotMessageId);
    clearSession(chatId);
    await mainMenu(tg, chatId, "<b>❌ Отчёт отменён.</b>");
    return;
  }
  if (text === "/status") {
    const s = getSession(chatId);
    if (!s) { await mainMenu(tg, chatId, "<b>ℹ️ Активного отчёта нет.</b>"); return; }
    await tg.sendMessage(chatId, `${summary(s)}\n\nТекущий этап: <b>${escapeHtml(s.state)}</b>`, MAIN_MENU);
    return;
  }

  const s = getSession(chatId);
  if (!s) { await mainMenu(tg, chatId); return; }

  switch (s.state) {
    case "awaiting_object":
      if (!text) { await replaceStep(tg, chatId, s, "Введите название или номер объекта.", CANCEL); return; }
      s.objectName = text;
      s.state = "awaiting_address";
      await replaceStep(tg, chatId, s, `<b>📍 Шаг 2 из 7 — Адрес</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\n\nВведите полный адрес.`, ADDRESS_MENU);
      return;

    case "awaiting_address":
      if (!text) { await replaceStep(tg, chatId, s, "Введите адрес текстом.", ADDRESS_MENU); return; }
      s.address = text;
      s.state = "confirm_address";
      await replaceStep(tg, chatId, s, `<b>📍 Проверка адреса</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\nАдрес: <b>${escapeHtml(s.address)}</b>\n\nВсё верно?`, CONFIRM_ADDRESS);
      return;

    case "awaiting_defects":
      if (!text) { await replaceStep(tg, chatId, s, "Напишите дефекты текстом или нажмите «Всё цело».", DEFECT_MENU); return; }
      s.defects = text;
      await adminText(tg, env, `⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 ${escapeHtml(s.defects)}`);
      await toAfterPhotos(tg, chatId, s);
      return;

    case "awaiting_expense_amount": {
      const amount = Number(text.replace(/\s/g, "").replace("₽", "").replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        await replaceStep(tg, chatId, s, "Введите сумму числом, например <b>850</b> или <b>850.50</b>.", CANCEL);
        return;
      }
      s.expenseAmount = Math.round(amount * 100) / 100;
      s.state = "confirm_finish";
      await replaceStep(tg, chatId, s, `<b>📋 Шаг 7 из 7 — Проверка</b>\n\n${summary(s)}\n\nПодтвердить отчёт?`, FINISH_MENU);
      return;

    default:
      await replaceStep(tg, chatId, s, "Используйте кнопку текущего шага или /cancel.", CANCEL);
  }
}

async function handleLocation(tg: TelegramClient, chatId: number, msg: TgMessage): Promise<void> {
  const s = getSession(chatId);
  if (!s) { await mainMenu(tg, chatId, "<b>Сначала создайте отчёт.</b>"); return; }
  if (s.state !== "awaiting_location" || !msg.location) return;

  s.latitude = msg.location.latitude;
  s.longitude = msg.location.longitude;
  s.state = "before_photos";
  await safeDelete(tg, chatId, s.lastBotMessageId);
  const m = await tg.sendMessage(chatId,
    `<b>📸 Шаг 4 из 7 — Фото ДО</b>\n\nГеопозиция получена ✅\n\nОтправьте фотографии объекта ДО уборки.\n\nФото ДО: <b>0</b>`,
    photoMenu("before"));
  s.lastBotMessageId = m.message_id;
  saveSession(chatId, s);
}

async function handlePhoto(tg: TelegramClient, chatId: number, msg: TgMessage): Promise<void> {
  const s = getSession(chatId);
  const photo = msg.photo?.at(-1);
  if (!photo) return;
  if (!s) { await mainMenu(tg, chatId, "<b>Нет активного отчёта.</b>"); return; }

  switch (s.state) {
    case "before_photos":
      if (s.beforePhotos.length >= MAX_PHOTOS) { await replaceStep(tg, chatId, s, `⚠️ Достигнут лимит ${MAX_PHOTOS} фото ДО.`, photoMenu("before")); return; }
      s.beforePhotos.push(photo.file_id);
      await replaceStep(tg, chatId, s, `✅ <b>Фото ДО принято</b>\n\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`, photoMenu("before"));
      return;

    case "after_photos":
      if (s.afterPhotos.length >= MAX_PHOTOS) { await replaceStep(tg, chatId, s, `⚠️ Достигнут лимит ${MAX_PHOTOS} фото ПОСЛЕ.`, photoMenu("after")); return; }
      s.afterPhotos.push(photo.file_id);
      await replaceStep(tg, chatId, s, `✅ <b>Фото ПОСЛЕ принято</b>\n\n📸 Фото ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`, photoMenu("after"));
      return;

    case "awaiting_receipt":
      s.expenseReceipt = photo.file_id;
      s.state = "awaiting_expense_amount";
      await replaceStep(tg, chatId, s, `<b>🧾 Чек получен</b>\n\nВведите сумму расхода числом.\n<i>Например: 850</i>`, CANCEL);
      return;

    default:
      await replaceStep(tg, chatId, s, "⚠️ Фото сейчас не ожидается. Следуйте текущему шагу.", CANCEL);
  }
}

async function handleCallback(tg: TelegramClient, env: Env, cq: TgCallbackQuery): Promise<void> {
  try { await tg.answerCallbackQuery(cq.id); } catch (error) { console.error("Callback answer failed", error); }
  const chatId = cq.message?.chat.id;
  if (!chatId || !isEmployee(env, cq.from.id)) return;
  const data = cq.data ?? "";
  const s = getSession(chatId);

  try {
    switch (true) {
      case data === "new_report":
        await startNewReport(tg, chatId, cq.from);
        return;
      case data === "help":
        await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU);
        return;
      case data === "my_reports":
        await tg.sendMessage(chatId, "<b>🗂 Мои отчёты</b>\n\nИстория будет подключена вместе с постоянным хранилищем. Активный отчёт работает прямо сейчас.", MAIN_MENU);
        return;
      case data === "profile":
        await tg.sendMessage(chatId, `👤 <b>Профиль</b>\n\nИмя: <b>${escapeHtml([cq.from.first_name, cq.from.last_name].filter(Boolean).join(" ") || "Без имени")}</b>\nUsername: <b>${escapeHtml(cq.from.username ? `@${cq.from.username}` : "не указан")}</b>\nID: <code>${cq.from.id}</code>`, MAIN_MENU);
        return;
      case data === "cancel":
        if (s) await safeDelete(tg, chatId, s.lastBotMessageId);
        clearSession(chatId);
        if (cq.message) await safeDelete(tg, chatId, cq.message.message_id);
        await mainMenu(tg, chatId, "<b>❌ Отчёт отменён.</b>");
        return;
      case data === "back_object":
        if (s?.state === "awaiting_address") {
          s.state = "awaiting_object";
          await replaceStep(tg, chatId, s, "🔙 <b>Шаг 1 из 7 — Объект</b>\n\nВведите название или номер объекта.", CANCEL);
        }
        return;
      case data === "edit_address":
        if (s?.state === "confirm_address") {
          s.state = "awaiting_address";
          await replaceStep(tg, chatId, s, "✏️ <b>Введите адрес ещё раз:</b>", ADDRESS_MENU);
        }
        return;
      case data === "address_ok":
        if (s?.state === "confirm_address") {
          s.state = "awaiting_location";
          await safeDelete(tg, chatId, s.lastBotMessageId);
          const m = await tg.sendMessage(chatId, `<b>📍 Шаг 3 из 7 — Геопозиция</b>\n\nАдрес: <b>${escapeHtml(s.address)}</b>\n\nНажмите кнопку ниже и отправьте текущую геопозицию.`, LOCATION_KEYBOARD);
          s.lastBotMessageId = m.message_id;
          saveSession(chatId, s);
        }
        return;
      case data === "finish_before":
        if (s?.state !== "before_photos") return;
        if (!s.beforePhotos.length) { await replaceStep(tg, chatId, s, "⚠️ Сначала отправьте хотя бы одно фото ДО.", photoMenu("before")); return; }
        s.beforeFinishedAt = new Date().toISOString();
        s.state = "awaiting_defects";
        await safeDelete(tg, chatId, s.lastBotMessageId);
        saveSession(chatId, s);
        await adminText(tg, env, startAdminText(s));
        await adminMedia(tg, env, s.beforePhotos, `🚀 <b>Фото ДО — ${escapeHtml(s.reportId)}</b>`);
        await replaceStep(tg, chatId, s, `<b>⚠️ Шаг 5 из 7 — Дефекты</b>\n\nЕсть ли повреждения или дефекты ДО уборки?\n\nВыберите «Всё цело» или нажмите «Указать дефекты».`, DEFECT_MENU);
        return;
      case data === "no_defects":
        if (s?.state !== "awaiting_defects") return;
        s.defects = "Нет дефектов";
        await adminText(tg, env, `⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 <b>Нет дефектов</b>`);
        await toAfterPhotos(tg, chatId, s);
        return;
      case data === "write_defects":
        if (s?.state !== "awaiting_defects") return;
        await replaceStep(tg, chatId, s, `<b>✏️ Опишите дефекты</b>\n\nНапишите одним сообщением, что было повреждено или уже имело дефект до уборки.`, CANCEL);
        return;
      case data === "finish_after":
        if (s?.state !== "after_photos") return;
        if (!s.afterPhotos.length) { await replaceStep(tg, chatId, s, "⚠️ Сначала отправьте хотя бы одно фото ПОСЛЕ.", photoMenu("after")); return; }
        s.afterFinishedAt = new Date().toISOString();
        s.state = "awaiting_expense_decision";
        await replaceStep(tg, chatId, s, `<b>💸 Шаг 6 из 7 — Расходы</b>\n\nБыли расходы на химию, такси или другие нужды объекта?`, EXPENSE_MENU);
        return;
      case data === "expense_yes":
        if (s?.state !== "awaiting_expense_decision") return;
        s.state = "awaiting_receipt";
        await replaceStep(tg, chatId, s, `<b>🧾 Пришлите фото чека</b>\n\nПосле фотографии я попрошу указать сумму.`, CANCEL);
        return;
      case data === "expense_no":
        if (s?.state !== "awaiting_expense_decision") return;
        s.state = "confirm_finish";
        s.expenseAmount = undefined;
        await replaceStep(tg, chatId, s, `<b>📋 Шаг 7 из 7 — Проверка</b>\n\n${summary(s)}\n\nПодтвердить отчёт?`, FINISH_MENU);
        return;
      case data === "continue_after":
        if (s?.state !== "confirm_finish") return;
        s.state = "after_photos";
        s.afterFinishedAt = undefined;
        await replaceStep(tg, chatId, s, `<b>📸 Возвращаемся к фото ПОСЛЕ</b>\n\nФото ПОСЛЕ: <b>${s.afterPhotos.length}</b>`, photoMenu("after"));
        return;
      case data === "confirm_finish":
        if (s?.state !== "confirm_finish") return;
        if (!s.beforePhotos.length || !s.afterPhotos.length) {
          await replaceStep(tg, chatId, s, "⚠️ Нельзя завершить отчёт без фото ДО и ПОСЛЕ.", FINISH_MENU);
          return;
        }
        s.afterFinishedAt = s.afterFinishedAt ?? new Date().toISOString();
        await adminText(tg, env, finalAdminText(s), {
          inline_keyboard: [
            [{ text: "✅ Принять отчёт", callback_data: `admin_accept:${s.reportId}` }],
            [{ text: "⚠️ Связаться с клинером", callback_data: `admin_contact:${s.reportId}:${s.cleaner.id}` }],
          ],
        });
        await adminMedia(tg, env, s.afterPhotos, `🏁 <b>Фото ПОСЛЕ — ${escapeHtml(s.reportId)}</b>`);
        if (s.expenseReceipt) await adminMedia(tg, env, [s.expenseReceipt], `🧾 <b>Чек — ${escapeHtml(s.reportId)}</b>`);
        await safeDelete(tg, chatId, s.lastBotMessageId);
        clearSession(chatId);
        await mainMenu(tg, chatId, `<b>🏁 Отчёт ${escapeHtml(s.reportId)} отправлен администратору.</b>`);
        return;
      case data === "admin_noop":
        return;
      case data.startsWith("admin_accept:"):
        if (chatId !== Number(env.ADMIN_CHAT_ID?.trim())) return;
        if (cq.message) await tg.editMessageReplyMarkup(chatId, cq.message.message_id, { inline_keyboard: [[{ text: "Принято ✅", callback_data: "admin_noop" }]] });
        return;
      case data.startsWith("admin_contact:"):
        if (chatId !== Number(env.ADMIN_CHAT_ID?.trim())) return;
        {
          const parts = data.split(":");
          const userId = Number(parts[2]);
          if (Number.isFinite(userId)) {
            await tg.sendMessage(chatId, `⚠️ <b>Клинер</b>\n\nTelegram ID: <code>${userId}</code>`, {
              inline_keyboard: [[{ text: "💬 Открыть профиль", url: `tg://user?id=${userId}` }]],
            });
          }
        }
        return;
      default:
        return;
    }
  } catch (error) {
    console.error("Callback handler failed", error);
    try { await tg.sendMessage(chatId, "⚠️ Не удалось обработать действие. Нажмите /start и повторите шаг."); } catch { /* ignore */ }
  }
}

function rememberUpdate(updateId: number): boolean {
  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 5000) {
    const first = processedUpdates.values().next().value;
    if (typeof first === "number") processedUpdates.delete(first);
  }
  return true;
}

function authorizedWebhook(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return !secret || request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

async function routeUpdate(tg: TelegramClient, env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(tg, env, update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg?.from || !isEmployee(env, msg.from.id)) return;

  // Important: media and location are routed before text. This is the photo FSM fix.
  if (msg.location) { await handleLocation(tg, msg.chat.id, msg); return; }
  if (msg.photo?.length) { await handlePhoto(tg, msg.chat.id, msg); return; }
  if (msg.text !== undefined) await handleText(tg, env, msg);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("House Cleaning bot is running", { status: 200 });
    if (request.method === "GET" && url.pathname === "/health") return new Response(JSON.stringify({ ok: true, worker: "hcotcet" }), { headers: { "content-type": "application/json" } });
    if (url.pathname !== "/webhook") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!authorizedWebhook(request, env)) return new Response("Forbidden", { status: 403 });

    let update: TgUpdate;
    try { update = await request.json() as TgUpdate; }
    catch { return new Response("Bad Request", { status: 400 }); }
    if (!update || typeof update.update_id !== "number") return new Response("Bad Request", { status: 400 });
    if (!rememberUpdate(update.update_id)) return new Response("OK", { status: 200 });

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    try { await routeUpdate(tg, env, update); }
    catch (error) { console.error("Webhook processing failed", error); }
    return new Response("OK", { status: 200 });
  },
};
