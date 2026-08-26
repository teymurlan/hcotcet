export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

type State =
  | "idle"
  | "awaiting_object"
  | "awaiting_address"
  | "before_photos"
  | "after_photos"
  | "confirm_finish";

interface TgUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; }
interface TgPhotoSize { file_id: string; file_unique_id: string; width: number; height: number; }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  photo?: TgPhotoSize[];
  reply_to_message?: TgMessage;
}
interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string; }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery; }

const API = "https://api.telegram.org/bot";
const sessions = new Map<number, Session>();
const processedUpdates = new Set<number>();

interface Session {
  state: State;
  objectName?: string;
  address?: string;
  beforeCount: number;
  afterCount: number;
}

class TelegramClient {
  constructor(private readonly token: string) {}

  private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${API}${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    if (!response.ok) throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    if (typeof parsed === "object" && parsed !== null && "ok" in parsed && !(parsed as { ok: boolean }).ok) {
      throw new Error(`Telegram ${method}: ${body}`);
    }
    return parsed;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  }
  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
  editMessageReplyMarkup(chatId: number, messageId: number) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }
}

const mainMenu = { inline_keyboard: [
  [{ text: "➕ Создать отчёт", callback_data: "new_report" }],
  [{ text: "🗂 Мои отчёты", callback_data: "my_reports" }, { text: "ℹ️ Помощь", callback_data: "help" }],
] };
const cancelMenu = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel" }]] };
const objectMenu = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel" }]] };
const addressMenu = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "back_object" }, { text: "❌ Отмена", callback_data: "cancel" }]] };
const beforeMenu = { inline_keyboard: [[{ text: "✅ Завершить этап ДО", callback_data: "finish_before" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const afterMenu = { inline_keyboard: [[{ text: "✅ Завершить отчёт", callback_data: "finish_after" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const confirmMenu = { inline_keyboard: [[{ text: "✅ Да, завершить", callback_data: "confirm_finish" }, { text: "↩️ Нет", callback_data: "continue_after" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };

const HELP = "<b>ℹ️ Помощь</b>\n\nЭтот бот предназначен для фотоотчётов по уборке объектов.\n\n<b>Порядок работы:</b> объект → адрес → фото ДО → фото ПОСЛЕ → завершение.\n\nНа любом этапе можно нажать «Отмена».";

function sessionFor(chatId: number): Session {
  return sessions.get(chatId) ?? { state: "idle", beforeCount: 0, afterCount: 0 };
}
function reset(chatId: number) { sessions.delete(chatId); }
function save(chatId: number, session: Session) { sessions.set(chatId, session); }
function forceReply(placeholder: string) { return { force_reply: true, selective: true, input_field_placeholder: placeholder }; }
function escapeHtml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

async function mainMenuMessage(tg: TelegramClient, chatId: number, prefix = "") {
  await tg.sendMessage(chatId, `${prefix}<b>House Cleaning — Фотоотчёты</b>\n\nВыберите действие:`, mainMenu);
}

async function handleText(tg: TelegramClient, msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  if (text === "/start") {
    reset(chatId);
    await mainMenuMessage(tg, chatId);
    return;
  }
  if (text === "/help") { await tg.sendMessage(chatId, HELP, mainMenu); return; }
  if (text === "/cancel" || text === "❌ Отмена") { reset(chatId); await mainMenuMessage(tg, chatId, "<b>Отчёт отменён.</b>\n\n"); return; }

  const s = sessionFor(chatId);
  if (s.state === "awaiting_object" && text) {
    s.objectName = text;
    s.state = "awaiting_address";
    save(chatId, s);
    await tg.sendMessage(chatId, `📍 Объект: <b>${escapeHtml(text)}</b>\n\nВведите адрес объекта:`, forceReply("Например: Дыбенко 6"));
    return;
  }
  if (s.state === "awaiting_address" && text) {
    s.address = text;
    s.state = "before_photos";
    save(chatId, s);
    await tg.sendMessage(chatId, `📸 <b>Фото ДО уборки</b>\n\nОбъект: <b>${escapeHtml(s.objectName ?? "")}</b>\nАдрес: <b>${escapeHtml(text)}</b>\n\nОтправляйте фотографии ДО. После последнего фото нажмите «Завершить этап ДО».`, beforeMenu);
    return;
  }
  await mainMenuMessage(tg, chatId);
}

async function handlePhoto(tg: TelegramClient, msg: TgMessage) {
  const chatId = msg.chat.id;
  const s = sessionFor(chatId);
  if (s.state === "before_photos") {
    s.beforeCount++;
    save(chatId, s);
    await tg.sendMessage(chatId, `✅ <b>Фото ДО принято</b> — ${s.beforeCount} шт.\n\nОтправьте следующее или завершите этап ДО.`, beforeMenu);
    return;
  }
  if (s.state === "after_photos") {
    s.afterCount++;
    save(chatId, s);
    await tg.sendMessage(chatId, `✅ <b>Фото ПОСЛЕ принято</b> — ${s.afterCount} шт.\n\nОтправьте следующее или нажмите «Завершить отчёт».`, afterMenu);
    return;
  }
  await tg.sendMessage(chatId, "Сначала создайте отчёт через кнопку «➕ Создать отчёт».", mainMenu);
}

async function handleCallback(tg: TelegramClient, cq: TgCallbackQuery) {
  const chatId = cq.message?.chat.id;
  if (!chatId) { await tg.answerCallbackQuery(cq.id); return; }
  try {
    await tg.answerCallbackQuery(cq.id);
    const s = sessionFor(chatId);
    switch (cq.data) {
      case "new_report":
        reset(chatId);
        save(chatId, { state: "awaiting_object", beforeCount: 0, afterCount: 0 });
        await tg.sendMessage(chatId, "➕ <b>Новый фотоотчёт</b>\n\nВведите название или номер объекта:", forceReply("Например: Объект №123"));
        break;
      case "my_reports":
        await tg.sendMessage(chatId, "🗂 <b>Мои отчёты</b>\n\nВ этой версии хранение отчётов ещё не подключено. После подключения D1 здесь появится история.", mainMenu);
        break;
      case "help": await tg.sendMessage(chatId, HELP, mainMenu); break;
      case "cancel": reset(chatId); await tg.editMessageReplyMarkup(chatId, cq.message!.message_id).catch(() => {}); await mainMenuMessage(tg, chatId, "<b>Отчёт отменён.</b>\n\n"); break;
      case "back_object":
        if (s.state === "awaiting_address") { s.state = "awaiting_object"; delete s.address; save(chatId, s); await tg.sendMessage(chatId, "🔙 Введите название или номер объекта ещё раз:", forceReply("Например: Объект №123")); }
        break;
      case "finish_before":
        if (s.state !== "before_photos") break;
        if (s.beforeCount < 1) { await tg.answerCallbackQuery(cq.id, "Сначала отправьте хотя бы одно фото ДО"); break; }
        s.state = "after_photos"; save(chatId, s); await tg.editMessageReplyMarkup(chatId, cq.message!.message_id).catch(() => {}); await tg.sendMessage(chatId, `📸 <b>Этап ДО завершён</b> — ${s.beforeCount} шт.\n\nТеперь отправляйте фотографии <b>ПОСЛЕ</b> уборки.`, afterMenu); break;
      case "finish_after":
        if (s.state !== "after_photos") break;
        if (s.afterCount < 1) { await tg.answerCallbackQuery(cq.id, "Сначала отправьте хотя бы одно фото ПОСЛЕ"); break; }
        s.state = "confirm_finish"; save(chatId, s); await tg.sendMessage(chatId, `Проверьте отчёт:\n\n📍 <b>${escapeHtml(s.objectName ?? "")}</b>\n🏠 ${escapeHtml(s.address ?? "")}\n📸 ДО: ${s.beforeCount}\n📸 ПОСЛЕ: ${s.afterCount}\n\n<b>Завершить отчёт?</b>`, confirmMenu); break;
      case "continue_after": if (s.state === "confirm_finish") { s.state = "after_photos"; save(chatId, s); await tg.sendMessage(chatId, "Продолжаем. Отправляйте фотографии ПОСЛЕ или нажмите «Завершить отчёт».", afterMenu); } break;
      case "confirm_finish":
        if (s.state !== "confirm_finish") break;
        reset(chatId); await tg.editMessageReplyMarkup(chatId, cq.message!.message_id).catch(() => {}); await mainMenuMessage(tg, chatId, "✅ <b>Фотоотчёт завершён!</b>\n\n"); break;
    }
  } catch (error) { console.error("Callback handler error", error); }
}

async function handleUpdate(env: Env, update: TgUpdate) {
  if (processedUpdates.has(update.update_id)) return;
  processedUpdates.add(update.update_id);
  if (processedUpdates.size > 5000) processedUpdates.delete(processedUpdates.values().next().value as number);
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  if (update.callback_query) return handleCallback(tg, update.callback_query);
  if (update.message?.photo) return handlePhoto(tg, update.message);
  if (update.message) return handleText(tg, update.message);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("x-telegram-bot-api-secret-token");
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      }
      try {
        const update = await request.json() as TgUpdate;
        await handleUpdate(env, update);
      } catch (error) { console.error("Webhook error", error); }
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};
