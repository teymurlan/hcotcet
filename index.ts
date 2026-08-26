export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

/**
 * House Cleaning — Photo Reports Bot v1.1
 *
 * Current storage: in-memory session only (temporary MVP).
 * D1/KV can be introduced later behind a SessionStore without changing the UX flow.
 * Telegram Bot API is accessed only through native fetch.
 */

type State =
  | "idle"
  | "awaiting_object"
  | "awaiting_address"
  | "confirm_address"
  | "before_photos"
  | "after_photos"
  | "confirm_finish";

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

interface Session {
  state: State;
  objectName: string;
  address: string;
  beforeCount: number;
  afterCount: number;
  reportId: string;
  startedAt: string;
}

const TELEGRAM_API = "https://api.telegram.org/bot";
const MAX_PROCESSED_UPDATES = 5000;

// Temporary MVP storage. Replace with KV/D1 SessionStore later.
const sessions = new Map<number, Session>();
const processedUpdates = new Set<number>();

class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.token.trim()) throw new Error("TELEGRAM_BOT_TOKEN is missing");

    const response = await fetch(`${TELEGRAM_API}${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }

    const telegramOk =
      typeof data === "object" &&
      data !== null &&
      "ok" in data &&
      (data as { ok: boolean }).ok === true;

    if (!response.ok || !telegramOk) {
      throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    }

    return data as T;
  }

  sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text, show_alert: false } : {}),
    });
  }

  editMessageReplyMarkup(chatId: number, messageId: number) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }
}

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "➕ Создать фотоотчёт", callback_data: "new_report" }],
    [
      { text: "🗂 Мои отчёты", callback_data: "my_reports" },
      { text: "ℹ️ Помощь", callback_data: "help" },
    ],
  ],
};

const CANCEL_ONLY = {
  inline_keyboard: [[{ text: "❌ Отменить отчёт", callback_data: "cancel" }]],
};

const ADDRESS_MENU = {
  inline_keyboard: [
    [
      { text: "🔙 Назад", callback_data: "back_object" },
      { text: "❌ Отмена", callback_data: "cancel" },
    ],
  ],
};

function photoMenu(phase: "before" | "after") {
  return {
    inline_keyboard: [
      [
        {
          text: phase === "before" ? "✅ Завершить ДО" : "✅ Завершить отчёт",
          callback_data: phase === "before" ? "finish_before" : "finish_after",
        },
      ],
      [{ text: "❌ Отменить отчёт", callback_data: "cancel" }],
    ],
  };
}

const CONFIRM_FINISH = {
  inline_keyboard: [
    [{ text: "✅ Да, завершить", callback_data: "confirm_finish" }],
    [{ text: "↩️ Продолжить фото", callback_data: "continue_after" }],
    [{ text: "❌ Отменить отчёт", callback_data: "cancel" }],
  ],
};

const HELP_TEXT =
  "<b>ℹ️ House Cleaning — Фотоотчёты</b>\n\n" +
  "Бот помогает сотруднику быстро оформить фотоотчёт по объекту.\n\n" +
  "<b>Порядок:</b>\n" +
  "1. Объект\n" +
  "2. Адрес\n" +
  "3. Фото ДО\n" +
  "4. Фото ПОСЛЕ\n" +
  "5. Проверка и завершение\n\n" +
  "В любой момент можно нажать «Отмена» или отправить /start для возврата в главное меню.";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeReportId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `HC-${code}`;
}

function makeSession(): Session {
  return {
    state: "awaiting_object",
    objectName: "",
    address: "",
    beforeCount: 0,
    afterCount: 0,
    reportId: makeReportId(),
    startedAt: new Date().toISOString(),
  };
}

function getSession(chatId: number): Session | null {
  return sessions.get(chatId) ?? null;
}

function clearSession(chatId: number): void {
  sessions.delete(chatId);
}

function saveSession(chatId: number, session: Session): void {
  sessions.set(chatId, session);
}

function formatStartedAt(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

async function showMainMenu(
  tg: TelegramClient,
  chatId: number,
  heading = "<b>House Cleaning</b>\n\nФотоотчёты по уборке объектов."
): Promise<void> {
  await tg.sendMessage(chatId, `${heading}\n\nВыберите действие:`, MAIN_MENU);
}

async function startNewReport(tg: TelegramClient, chatId: number): Promise<void> {
  saveSession(chatId, makeSession());
  await tg.sendMessage(
    chatId,
    "<b>➕ Новый фотоотчёт</b>\n\n<b>Шаг 1 из 4</b>\n\nВведите название или номер объекта.\n\n<i>Например: Объект №123</i>",
    CANCEL_ONLY
  );
}

async function handleText(tg: TelegramClient, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  if (text === "/start") {
    clearSession(chatId);
    await showMainMenu(tg, chatId, "<b>👋 Добро пожаловать в House Cleaning</b>");
    return;
  }

  if (text === "/help") {
    await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU);
    return;
  }

  if (text === "/cancel") {
    clearSession(chatId);
    await showMainMenu(tg, chatId, "<b>❌ Отчёт отменён.</b>");
    return;
  }

  const session = getSession(chatId);

  if (!session) {
    await showMainMenu(tg, chatId);
    return;
  }

  if (session.state === "awaiting_object") {
    if (!text) {
      await tg.sendMessage(chatId, "Введите название или номер объекта текстом.", CANCEL_ONLY);
      return;
    }

    session.objectName = text;
    session.state = "awaiting_address";
    saveSession(chatId, session);

    await tg.sendMessage(
      chatId,
      `📍 <b>Шаг 2 из 4 — Адрес</b>\n\nОбъект: <b>${escapeHtml(session.objectName)}</b>\n\nВведите полный адрес объекта.",
      ADDRESS_MENU
    );
    return;
  }

  if (session.state === "awaiting_address") {
    if (!text) {
      await tg.sendMessage(chatId, "Введите адрес текстом.", ADDRESS_MENU);
      return;
    }

    session.address = text;
    session.state = "confirm_address";
    saveSession(chatId, session);

    await tg.sendMessage(
      chatId,
      `📍 <b>Проверьте адрес</b>\n\nОбъект: <b>${escapeHtml(session.objectName)}</b>\nАдрес: <b>${escapeHtml(session.address)}</b>\n\nВсё верно?`,
      {
        inline_keyboard: [
          [{ text: "✅ Да, всё верно", callback_data: "address_ok" }],
          [
            { text: "✏️ Изменить", callback_data: "edit_address" },
            { text: "❌ Отмена", callback_data: "cancel" },
          ],
        ],
      }
    );
    return;
  }

  if (session.state === "before_photos" || session.state === "after_photos") {
    await tg.sendMessage(
      chatId,
      session.state === "before_photos"
        ? "📸 Сейчас нужно отправлять фотографии <b>ДО</b> уборки."
        : "📸 Сейчас нужно отправлять фотографии <b>ПОСЛЕ</b> уборки.",
      photoMenu(session.state === "before_photos" ? "before" : "after")
    );
    return;
  }

  if (session.state === "confirm_finish") {
    await tg.sendMessage(chatId, "Выберите действие кнопками ниже.", CONFIRM_FINISH);
    return;
  }

  await showMainMenu(tg, chatId);
}

async function handlePhoto(tg: TelegramClient, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session) {
    await tg.sendMessage(chatId, "Сначала создайте фотоотчёт.", MAIN_MENU);
    return;
  }

  // Telegram sends photo sizes as an ordered array; the last item is normally the largest.
  const largestPhoto = msg.photo?.[msg.photo.length - 1];
  if (!largestPhoto) return;

  if (session.state === "before_photos") {
    session.beforeCount += 1;
    saveSession(chatId, session);
    await tg.sendMessage(
      chatId,
      `✅ <b>Фото ДО принято</b>\n\nПринято: <b>${session.beforeCount}</b>\n\nОтправьте следующее фото или завершите этап ДО.`,
      photoMenu("before")
    );
    return;
  }

  if (session.state === "after_photos") {
    session.afterCount += 1;
    saveSession(chatId, session);
    await tg.sendMessage(
      chatId,
      `✅ <b>Фото ПОСЛЕ принято</b>\n\nПринято: <b>${session.afterCount}</b>\n\nОтправьте следующее фото или нажмите «Завершить отчёт».`,
      photoMenu("after")
    );
    return;
  }

  await tg.sendMessage(
    chatId,
    "⚠️ Сейчас фотография не ожидается. Создайте новый отчёт или продолжите текущий этап.",
    MAIN_MENU
  );
}

async function handleCallback(tg: TelegramClient, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;

  // Always acknowledge exactly once, before doing longer work.
  try {
    await tg.answerCallbackQuery(cq.id);
  } catch (error) {
    console.error("answerCallbackQuery failed", error);
  }

  if (!chatId) return;

  try {
    const data = cq.data ?? "";
    const session = getSession(chatId);

    switch (data) {
      case "new_report":
        await startNewReport(tg, chatId);
        return;

      case "help":
        await tg.sendMessage(chatId, HELP_TEXT, MAIN_MENU);
        return;

      case "my_reports":
        await tg.sendMessage(
          chatId,
          "<b>🗂 Мои отчёты</b>\n\nИстория будет подключена вместе с постоянным хранилищем D1.\n\nСейчас отчёты работают в демонстрационном режиме и не сохраняются после перезапуска Worker.",
          MAIN_MENU
        );
        return;

      case "cancel":
        clearSession(chatId);
        if (cq.message) {
          await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
        }
        await showMainMenu(tg, chatId, "<b>❌ Фотоотчёт отменён.</b>");
        return;

      case "back_object":
        if (session?.state === "awaiting_address") {
          session.state = "awaiting_object";
          session.address = "";
          saveSession(chatId, session);
          await tg.sendMessage(chatId, "🔙 <b>Шаг 1 из 4</b>\n\nВведите название или номер объекта.", CANCEL_ONLY);
        }
        return;

      case "address_ok":
        if (!session || session.state !== "confirm_address") return;
        session.state = "before_photos";
        saveSession(chatId, session);
        await tg.sendMessage(
          chatId,
          `📸 <b>Шаг 3 из 4 — Фото ДО</b>\n\nОбъект: <b>${escapeHtml(session.objectName)}</b>\nАдрес: <b>${escapeHtml(session.address)}</b>\n\nОтправьте все необходимые фотографии ДО уборки. После последнего фото нажмите «Завершить ДО».`,
          photoMenu("before")
        );
        return;

      case "edit_address":
        if (!session || session.state !== "confirm_address") return;
        session.state = "awaiting_address";
        saveSession(chatId, session);
        await tg.sendMessage(chatId, "✏️ Введите адрес ещё раз:", ADDRESS_MENU);
        return;

      case "finish_before":
        if (!session || session.state !== "before_photos") return;
        if (session.beforeCount < 1) {
          await tg.sendMessage(chatId, "⚠️ Нельзя завершить этап: отправьте хотя бы одно фото ДО.", photoMenu("before"));
          return;
        }
        session.state = "after_photos";
        saveSession(chatId, session);
        if (cq.message) {
          await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
        }
        await tg.sendMessage(
          chatId,
          `✅ <b>Этап ДО завершён</b>\n\nПринято фотографий ДО: <b>${session.beforeCount}</b>\n\n📸 <b>Шаг 4 из 4 — Фото ПОСЛЕ</b>\n\nТеперь отправляйте фотографии результата уборки.`,
          photoMenu("after")
        );
        return;

      case "finish_after":
        if (!session || session.state !== "after_photos") return;
        if (session.afterCount < 1) {
          await tg.sendMessage(chatId, "⚠️ Нельзя завершить отчёт: отправьте хотя бы одно фото ПОСЛЕ.", photoMenu("after"));
          return;
        }
        session.state = "confirm_finish";
        saveSession(chatId, session);
        await tg.sendMessage(
          chatId,
          `<b>📋 Проверьте фотоотчёт</b>\n\n` +
            `Номер: <b>${escapeHtml(session.reportId)}</b>\n` +
            `Объект: <b>${escapeHtml(session.objectName)}</b>\n` +
            `Адрес: <b>${escapeHtml(session.address)}</b>\n\n` +
            `📸 Фото ДО: <b>${session.beforeCount}</b>\n` +
            `📸 Фото ПОСЛЕ: <b>${session.afterCount}</b>\n` +
            `🕒 Начат: <b>${formatStartedAt(session.startedAt)}</b>\n\n` +
            `<b>Всё верно? Завершить отчёт?</b>`,
          CONFIRM_FINISH
        );
        return;

      case "continue_after":
        if (!session || session.state !== "confirm_finish") return;
        session.state = "after_photos";
        saveSession(chatId, session);
        await tg.sendMessage(chatId, "↩️ <b>Продолжаем этап ПОСЛЕ.</b>\n\nОтправляйте дополнительные фотографии.", photoMenu("after"));
        return;

      case "confirm_finish":
        if (!session || session.state !== "confirm_finish") return;
        clearSession(chatId);
        if (cq.message) {
          await tg.editMessageReplyMarkup(chatId, cq.message.message_id).catch(() => undefined);
        }
        await tg.sendMessage(
          chatId,
          `<b>✅ Фотоотчёт завершён</b>\n\n` +
            `Номер: <b>${escapeHtml(session.reportId)}</b>\n` +
            `Объект: <b>${escapeHtml(session.objectName)}</b>\n` +
            `📸 ДО: <b>${session.beforeCount}</b>\n` +
            `📸 ПОСЛЕ: <b>${session.afterCount}</b>\n\n` +
            `Спасибо за работу.`,
          MAIN_MENU
        );
        return;

      default:
        await showMainMenu(tg, chatId);
    }
  } catch (error) {
    console.error("Callback handler error", error);
    await tg.sendMessage(chatId, "⚠️ Произошла ошибка. Попробуйте ещё раз или отправьте /start.", MAIN_MENU).catch(() => undefined);
  }
}

async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (processedUpdates.has(update.update_id)) return;
  processedUpdates.add(update.update_id);

  if (processedUpdates.size > MAX_PROCESSED_UPDATES) {
    const oldest = processedUpdates.values().next().value as number | undefined;
    if (oldest !== undefined) processedUpdates.delete(oldest);
  }

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
      // If a secret exists in Cloudflare Runtime variables, enforce it.
      // If it is temporarily absent, webhook still works for the MVP.
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("x-telegram-bot-api-secret-token");
        if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
      }

      try {
        const update = (await request.json()) as TgUpdate;
        await handleUpdate(env, update);
      } catch (error) {
        // Return 200 to Telegram after safely handling/logging the update.
        // This prevents endless webhook retries while the issue is diagnosed.
        console.error("Webhook handler error", error);
      }

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
