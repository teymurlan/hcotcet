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
  reply_to_message?: TgMessage;
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
  constructor(private readonly token: string) {}

  private async call(method: string, payload: Record<string, unknown>) {
    try {
      const response = await fetch(`${API_BASE}${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`Telegram API ${method} failed: ${response.status} ${body}`);
      }

      return response;
    } catch (error) {
      console.error(`Telegram API ${method} request failed`, error);
      throw error;
    }
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}

const mainMenu = {
  inline_keyboard: [
    [{ text: "➕ Создать отчёт", callback_data: "new_report" }],
    [
      { text: "🗂 Мои отчёты", callback_data: "my_reports" },
      { text: "ℹ️ Помощь", callback_data: "help" },
    ],
  ],
};

const cancelMenu = {
  inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel" }]],
};

const photoMenu = {
  inline_keyboard: [[{ text: "✅ Завершить отчёт", callback_data: "finish_report" }], [{ text: "❌ Отмена", callback_data: "cancel" }]],
};

const HELP_TEXT =
  "<b>ℹ️ Помощь</b>\n\n" +
  "Этот бот предназначен для фотоотчётов по уборке объектов.\n\n" +
  "<b>Как создать отчёт:</b>\n" +
  "1. Нажмите «Создать отчёт».\n" +
  "2. Отправьте название объекта.\n" +
  "3. Отправьте адрес.\n" +
  "4. Отправьте фотографии ДО и ПОСЛЕ уборки.\n\n" +
  "Сейчас бот работает без базы данных, поэтому данные временно не сохраняются.";

function forceReply(placeholder: string) {
  return {
    force_reply: true,
    input_field_placeholder: placeholder,
    selective: true,
  };
}

async function sendMainMenu(tg: TelegramClient, chatId: number) {
  await tg.sendMessage(
    chatId,
    "<b>House Cleaning — Фотоотчёты</b>\n\nВыберите действие:",
    mainMenu
  );
}

async function handleStart(tg: TelegramClient, chatId: number) {
  await sendMainMenu(tg, chatId);
}

async function handleText(tg: TelegramClient, msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (text === "/start") {
    await handleStart(tg, chatId);
    return;
  }

  if (text === "/help") {
    await tg.sendMessage(chatId, HELP_TEXT, mainMenu);
    return;
  }

  if (msg.reply_to_message?.text?.includes("Введите название или номер объекта")) {
    await tg.sendMessage(
      chatId,
      `📍 Объект: <b>${escapeHtml(text ?? "")}</b>\n\nТеперь отправьте адрес объекта.`,
      forceReply("Например: Дыбенко 6")
    );
    return;
  }

  if (msg.reply_to_message?.text?.includes("Теперь отправьте адрес объекта")) {
    await tg.sendMessage(
      chatId,
      "📸 <b>Фото ДО уборки</b>\n\nОтправьте фотографии ДО уборки. Можно отправить несколько сообщений с фотографиями.\n\nКогда закончите — нажмите «Завершить этап ДО».",
      {
        inline_keyboard: [
          [{ text: "✅ Завершить этап ДО", callback_data: "finish_before" }],
          [{ text: "❌ Отмена", callback_data: "cancel" }],
        ],
      }
    );
    return;
  }

  await sendMainMenu(tg, chatId);
}

async function handlePhoto(tg: TelegramClient, msg: TgMessage) {
  const chatId = msg.chat.id;
  const largest = msg.photo?.[msg.photo.length - 1];

  if (!largest) return;

  await tg.sendMessage(
    chatId,
    "✅ <b>Фото принято!</b>\n\nОтправьте следующее или нажмите кнопку завершения этапа.",
    photoMenu
  );
}

async function handleCallback(tg: TelegramClient, cq: TgCallbackQuery) {
  try {
    await tg.answerCallbackQuery(cq.id);

    const chatId = cq.message?.chat.id;
    if (!chatId) return;

    switch (cq.data) {
      case "new_report":
        await tg.sendMessage(
          chatId,
          "➕ <b>Новый фотоотчёт</b>\n\nВведите название или номер объекта:",
          forceReply("Например: Объект №123")
        );
        return;

      case "my_reports":
        await tg.sendMessage(
          chatId,
          "🗂 <b>Мои отчёты</b>\n\nПока база данных отключена, сохранённые отчёты недоступны. Эта функция будет подключена позже.",
          mainMenu
        );
        return;

      case "help":
        await tg.sendMessage(chatId, HELP_TEXT, mainMenu);
        return;

      case "cancel":
        await sendMainMenu(tg, chatId);
        return;

      case "finish_before":
        await tg.sendMessage(
          chatId,
          "📸 <b>Фото ДО завершены</b>\n\nТеперь отправьте фотографии <b>ПОСЛЕ</b> уборки.\n\nКогда закончите — нажмите «Завершить отчёт».",
          photoMenu
        );
        return;

      case "finish_report":
        await tg.sendMessage(
          chatId,
          "✅ <b>Фотоотчёт завершён</b>\n\nСпасибо! В текущем тестовом режиме данные не сохраняются.",
          mainMenu
        );
        return;

      default:
        return;
    }
  } catch (error) {
    console.error("Callback handler error", error);
  }
}

function escapeHtml(value: string | undefined) {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function handleUpdate(env: Env, update: TgUpdate) {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);

  if (update.callback_query) {
    await handleCallback(tg, update.callback_query);
    return;
  }

  if (update.message?.photo) {
    await handlePhoto(tg, update.message);
    return;
  }

  if (update.message) {
    await handleText(tg, update.message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = (await request.json()) as TgUpdate;
        await handleUpdate(env, update);
        return new Response("ok", { status: 200 });
      } catch (error) {
        console.error("Webhook error", error);
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("not found", { status: 404 });
  },
};
