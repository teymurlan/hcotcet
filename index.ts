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

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const API_BASE = "https://api.telegram.org/bot";

async function telegramSendMessage(env: Env, chatId: number, text: string, replyMarkup?: unknown) {
  const response = await fetch(`${API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }

  return response;
}

const mainMenuKeyboard = {
  keyboard: [
    [{ text: "📋 Новый фотоотчёт" }],
    [{ text: "🗂 Мои отчёты" }, { text: "ℹ️ Помощь" }],
  ],
  resize_keyboard: true,
};

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

      try {
        if (update.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text?.trim();

          if (text === "/start") {
            await telegramSendMessage(
              env,
              chatId,
              "<b>House Cleaning — Фотоотчёты</b>\n\nБот работает. База данных временно отключена.\n\nВыберите действие:",
              mainMenuKeyboard
            );
          } else if (text === "ℹ️ Помощь" || text === "/help") {
            await telegramSendMessage(
              env,
              chatId,
              "Этот бот предназначен для фотоотчётов по уборке объектов.\n\nСейчас работает тестовый режим без сохранения данных.",
              mainMenuKeyboard
            );
          } else if (text === "📋 Новый фотоотчёт" || text === "/new") {
            await telegramSendMessage(
              env,
              chatId,
              "📋 <b>Новый фотоотчёт</b>\n\nТестовый режим: отправьте название объекта.",
              mainMenuKeyboard
            );
          } else if (text === "🗂 Мои отчёты" || text === "/reports") {
            await telegramSendMessage(
              env,
              chatId,
              "🗂 Сохранение базы временно отключено. Отчётов пока нет.",
              mainMenuKeyboard
            );
          } else if (update.message.photo?.length) {
            await telegramSendMessage(env, chatId, "Фото получено. Сейчас работаем без сохранения в базе.");
          } else {
            await telegramSendMessage(env, chatId, "Бот получил сообщение. Выберите действие в меню:", mainMenuKeyboard);
          }
        }
      } catch (error) {
        console.error("Webhook handler error", error);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
