export interface Env {
  TELEGRAM_BOT_TOKEN: string;
}

interface TgUser {
  id: number;
  is_bot: boolean;
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

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  photo?: TgPhotoSize[];
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

const API_BASE = "https://api.telegram.org/bot";

class TelegramClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async call(method: string, payload: Record<string, unknown>) {
    const res = await fetch(`${API_BASE}${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Telegram API ${method} failed: ${res.status} ${body}`);
    }

    return res;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      parse_mode: "HTML",
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}

const mainMenuKeyboard = {
  keyboard: [
    [{ text: "📋 Новый фотоотчёт" }],
    [{ text: "🗂 Мои отчёты" }, { text: "ℹ️ Помощь" }],
  ],
  resize_keyboard: true,
};

const HELP_TEXT =
  "Этот бот нужен для фотоотчётов по уборке объектов.\n\n" +
  "📋 <b>Новый фотоотчёт</b> — начать новый фотоотчёт.\n" +
  "🗂 <b>Мои отчёты</b> — просмотр отчётов будет подключён после подключения базы данных.\n\n" +
  "Сейчас бот работает в тестовом режиме без сохранения данных.";

async function handleMessage(env: Env, tg: TelegramClient, msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (text === "/start") {
    await tg.sendMessage(
      chatId,
      "<b>House Cleaning — Фотоотчёты</b>\n\nБот работает.\n\nВыберите действие в меню ниже.",
      mainMenuKeyboard
    );
    return;
  }

  if (text === "ℹ️ Помощь" || text === "/help") {
    await tg.sendMessage(chatId, HELP_TEXT, mainMenuKeyboard);
    return;
  }

  if (text === "📋 Новый фотоотчёт" || text === "/new") {
    await tg.sendMessage(
      chatId,
      "📋 <b>Новый фотоотчёт</b>\n\nТестовый режим без базы данных.\n\nОтправьте название или номер объекта.",
      mainMenuKeyboard
    );
    return;
  }

  if (text === "🗂 Мои отчёты" || text === "/reports") {
    await tg.sendMessage(
      chatId,
      "🗂 <b>Мои отчёты</b>\n\nСохранение и просмотр отчётов будут подключены после включения базы данных.",
      mainMenuKeyboard
    );
    return;
  }

  if (msg.photo?.length) {
    await tg.sendMessage(
      chatId,
      "Фото получено. Сейчас работает тестовый режим без сохранения в базе.",
      mainMenuKeyboard
    );
    return;
  }

  await tg.sendMessage(chatId, "Выберите действие в меню:", mainMenuKeyboard);
}

async function handleCallback(env: Env, tg: TelegramClient, cq: TgCallbackQuery) {
  await tg.answerCallbackQuery(cq.id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      let update: TgUpdate;

      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }

      const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);

      try {
        if (update.message) {
          await handleMessage(env, tg, update.message);
        } else if (update.callback_query) {
          await handleCallback(env, tg, update.callback_query);
        }
      } catch (error) {
        console.error("Webhook handler error", error);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
