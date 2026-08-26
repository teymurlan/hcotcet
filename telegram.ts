// Тонкая обёртка над Telegram Bot API.
// Никаких внешних зависимостей — только fetch.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  photo?: TgPhotoSize[];
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const API_BASE = "https://api.telegram.org/bot";

export class TelegramClient {
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

  setWebhook(url: string, secretToken: string) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    });
  }
}

// --- Клавиатуры ---

export const mainMenuKeyboard = {
  keyboard: [
    [{ text: "📋 Новый фотоотчёт" }],
    [{ text: "🗂 Мои отчёты" }, { text: "ℹ️ Помощь" }],
  ],
  resize_keyboard: true,
};

export function doneButton(phase: "before" | "after") {
  return {
    inline_keyboard: [
      [
        {
          text: phase === "before" ? "✅ Фото ДО отправлены" : "✅ Фото ПОСЛЕ отправлены",
          callback_data: `done_${phase}`,
        },
      ],
    ],
  };
}
