import {
  TelegramClient,
  TgUpdate,
  TgMessage,
  TgCallbackQuery,
  mainMenuKeyboard,
  doneButton,
} from "./telegram";
import {
  ensureEmployee,
  getSession,
  saveSession,
  resetSession,
  createObject,
  createReport,
  addPhoto,
  countPhotos,
  completeReport,
  listRecentReports,
  logAction,
} from "./db";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

const HELP_TEXT =
  "Этот бот нужен для фотоотчётов по уборке объектов.\n\n" +
  "📋 <b>Новый фотоотчёт</b> — создать отчёт: объект, адрес, фото ДО и ПОСЛЕ уборки.\n" +
  "🗂 <b>Мои отчёты</b> — последние отчёты, которые вы отправили.\n\n" +
  "Если начали отчёт и хотите отменить — просто нажмите «📋 Новый фотоотчёт» ещё раз, он начнётся заново.";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

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
      } catch (err) {
        console.error("Error handling update", err);
      }

      // Telegram ждёт 200 OK независимо от результата обработки,
      // иначе будет повторять доставку апдейта.
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleMessage(env: Env, tg: TelegramClient, msg: TgMessage) {
  if (!msg.from) return;
  const chatId = msg.chat.id;
  const employeeId = await ensureEmployee(env.DB, msg.from);
  const session = await getSession(env.DB, chatId);

  const text = msg.text?.trim();

  if (text === "/start") {
    await resetSession(env.DB, chatId);
    await tg.sendMessage(
      chatId,
      "<b>House Cleaning — Фотоотчёты</b>\n\nВыберите действие в меню ниже.",
      mainMenuKeyboard
    );
    return;
  }

  if (text === "ℹ️ Помощь" || text === "/help") {
    await tg.sendMessage(chatId, HELP_TEXT, mainMenuKeyboard);
    return;
  }

  if (text === "🗂 Мои отчёты" || text === "/reports") {
    const reports = await listRecentReports(env.DB, employeeId, 5);
    if (!reports.length) {
      await tg.sendMessage(chatId, "У вас пока нет отчётов.", mainMenuKeyboard);
      return;
    }
    const statusLabel: Record<string, string> = {
      in_progress: "🟡 в процессе",
      completed: "✅ завершён",
    };
    const lines = reports.map(
      (r) =>
        `<b>${r.public_id}</b> — ${r.object_name}\n${statusLabel[r.status] ?? r.status} · ${r.started_at}`
    );
    await tg.sendMessage(chatId, lines.join("\n\n"), mainMenuKeyboard);
    return;
  }

  if (text === "📋 Новый фотоотчёт" || text === "/new") {
    await saveSession(env.DB, {
      telegram_id: chatId,
      state: "awaiting_object_name",
      report_id: null,
      object_name: null,
      address: null,
      latitude: null,
      longitude: null,
    });
    await tg.sendMessage(chatId, "Введите название или номер объекта:");
    return;
  }

  // --- Ветки, зависящие от текущего состояния диалога ---

  if (session.state === "awaiting_object_name") {
    if (!text) {
      await tg.sendMessage(chatId, "Пожалуйста, отправьте название объекта текстом.");
      return;
    }
    session.object_name = text;
    session.state = "awaiting_address";
    await saveSession(env.DB, session);
    await tg.sendMessage(chatId, "Теперь укажите адрес объекта:");
    return;
  }

  if (session.state === "awaiting_address") {
    if (!text) {
      await tg.sendMessage(chatId, "Пожалуйста, отправьте адрес текстом.");
      return;
    }
    session.address = text;

    const objectId = await createObject(env.DB, session.object_name!, session.address);
    const { reportId, publicId } = await createReport(env.DB, employeeId, objectId);
    await logAction(env.DB, chatId, "report_started", reportId, session.object_name!);

    session.state = "awaiting_photos_before";
    session.report_id = reportId;
    await saveSession(env.DB, session);

    await tg.sendMessage(
      chatId,
      `Отчёт <b>${publicId}</b> создан.\n\nОтправьте фотографии <b>ДО</b> уборки. Когда закончите — нажмите кнопку под сообщением.`,
      doneButton("before")
    );
    return;
  }

  if (session.state === "awaiting_photos_before" && msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    await addPhoto(env.DB, session.report_id!, "before", largest.file_id, largest.file_unique_id);
    return;
  }

  if (session.state === "awaiting_photos_after" && msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    await addPhoto(env.DB, session.report_id!, "after", largest.file_id, largest.file_unique_id);
    return;
  }

  if (
    (session.state === "awaiting_photos_before" || session.state === "awaiting_photos_after") &&
    !msg.photo
  ) {
    await tg.sendMessage(chatId, "Отправьте, пожалуйста, фотографию, либо нажмите кнопку «Готово» под предыдущим сообщением.");
    return;
  }

  // Нет активного сценария — просто покажем меню
  await tg.sendMessage(chatId, "Выберите действие в меню:", mainMenuKeyboard);
}

async function handleCallback(env: Env, tg: TelegramClient, cq: TgCallbackQuery) {
  const chatId = cq.message?.chat.id;
  if (!chatId) return;
  const session = await getSession(env.DB, chatId);

  if (cq.data === "done_before" && session.state === "awaiting_photos_before") {
    const count = await countPhotos(env.DB, session.report_id!, "before");
    if (count === 0) {
      await tg.answerCallbackQuery(cq.id, "Сначала отправьте хотя бы одно фото");
      return;
    }
    session.state = "awaiting_photos_after";
    await saveSession(env.DB, session);
    await tg.answerCallbackQuery(cq.id, "Фото ДО сохранены");
    await tg.sendMessage(chatId, "Теперь отправьте фотографии <b>ПОСЛЕ</b> уборки.", doneButton("after"));
    return;
  }

  if (cq.data === "done_after" && session.state === "awaiting_photos_after") {
    const count = await countPhotos(env.DB, session.report_id!, "after");
    if (count === 0) {
      await tg.answerCallbackQuery(cq.id, "Сначала отправьте хотя бы одно фото");
      return;
    }
    await completeReport(env.DB, session.report_id!);
    await logAction(env.DB, chatId, "report_completed", session.report_id, null);
    await tg.answerCallbackQuery(cq.id, "Отчёт завершён");
    await resetSession(env.DB, chatId);
    await tg.sendMessage(chatId, "✅ <b>Фотоотчёт завершён</b>. Спасибо!", mainMenuKeyboard);
    return;
  }

  await tg.answerCallbackQuery(cq.id);
}
