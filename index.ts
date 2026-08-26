export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
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

function doneButton(phase: "before" | "after") {
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

interface Session {
  telegram_id: number;
  state: string | null;
  report_id: number | null;
  object_name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

async function ensureEmployee(db: D1Database, user: TgUser) {
  await db
    .prepare(
      `INSERT INTO employees (telegram_id, first_name, last_name, username)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         username = excluded.username`
    )
    .bind(user.id, user.first_name ?? null, user.last_name ?? null, user.username ?? null)
    .run();

  const row = await db
    .prepare(`SELECT id FROM employees WHERE telegram_id = ?`)
    .bind(user.id)
    .first<{ id: number }>();
  return row!.id;
}

async function getSession(db: D1Database, telegramId: number): Promise<Session> {
  const row = await db
    .prepare(`SELECT * FROM sessions WHERE telegram_id = ?`)
    .bind(telegramId)
    .first<Session>();
  if (row) return row;
  return {
    telegram_id: telegramId,
    state: "idle",
    report_id: null,
    object_name: null,
    address: null,
    latitude: null,
    longitude: null,
  };
}

async function saveSession(db: D1Database, session: Session) {
  await db
    .prepare(
      `INSERT INTO sessions (telegram_id, state, report_id, object_name, address, latitude, longitude, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         state = excluded.state,
         report_id = excluded.report_id,
         object_name = excluded.object_name,
         address = excluded.address,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         updated_at = datetime('now')`
    )
    .bind(
      session.telegram_id,
      session.state,
      session.report_id,
      session.object_name,
      session.address,
      session.latitude,
      session.longitude
    )
    .run();
}

async function resetSession(db: D1Database, telegramId: number) {
  await saveSession(db, {
    telegram_id: telegramId,
    state: "idle",
    report_id: null,
    object_name: null,
    address: null,
    latitude: null,
    longitude: null,
  });
}

async function createObject(db: D1Database, name: string, address: string) {
  const res = await db
    .prepare(`INSERT INTO objects (name, address) VALUES (?, ?)`)
    .bind(name, address)
    .run();
  return res.meta.last_row_id as number;
}

function generatePublicId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `HC-${code}`;
}

async function createReport(db: D1Database, employeeId: number, objectId: number) {
  const publicId = generatePublicId();
  const res = await db
    .prepare(
      `INSERT INTO reports (public_id, employee_id, object_id, status)
       VALUES (?, ?, ?, 'in_progress')`
    )
    .bind(publicId, employeeId, objectId)
    .run();
  return { reportId: res.meta.last_row_id as number, publicId };
}

async function addPhoto(
  db: D1Database,
  reportId: number,
  phase: "before" | "after",
  fileId: string,
  fileUniqueId: string
) {
  await db
    .prepare(
      `INSERT INTO report_photos (report_id, phase, telegram_file_id, telegram_file_unique_id)
       VALUES (?, ?, ?, ?)`
    )
    .bind(reportId, phase, fileId, fileUniqueId)
    .run();
}

async function countPhotos(db: D1Database, reportId: number, phase: "before" | "after") {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM report_photos WHERE report_id = ? AND phase = ?`)
    .bind(reportId, phase)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function completeReport(db: D1Database, reportId: number) {
  await db
    .prepare(
      `UPDATE reports SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(reportId)
    .run();
}

async function listRecentReports(db: D1Database, employeeId: number, limit = 5) {
  const { results } = await db
    .prepare(
      `SELECT r.public_id, r.status, r.started_at, o.name as object_name
       FROM reports r
       JOIN objects o ON o.id = r.object_id
       WHERE r.employee_id = ?
       ORDER BY r.started_at DESC
       LIMIT ?`
    )
    .bind(employeeId, limit)
    .all<{ public_id: string; status: string; started_at: string; object_name: string }>();
  return results;
}

async function logAction(
  db: D1Database,
  telegramId: number,
  action: string,
  reportId: number | null,
  details?: string
) {
  await db
    .prepare(
      `INSERT INTO audit_log (telegram_id, action, report_id, details) VALUES (?, ?, ?, ?)`
    )
    .bind(telegramId, action, reportId, details ?? null)
    .run();
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

    if (request.method === "GET" && url.pathname === "/debug-check-secret") {
      const candidate = url.searchParams.get("value") ?? "";
      const expected = env.TELEGRAM_WEBHOOK_SECRET ?? "";
      return new Response(
        JSON.stringify({
          match: candidate === expected,
          expected_length: expected.length,
          candidate_length: candidate.length,
        }),
        { headers: { "content-type": "application/json" } }
      );
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
      await tg.sendMessage(chatId, "Пожалуйста, отправьте адрес объекта текстом.");
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
    await tg.sendMessage(
      chatId,
      "Отправьте, пожалуйста, фотографию, либо нажмите кнопку «Готово» под предыдущим сообщением."
    );
    return;
  }

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
    await logAction(env.DB, chatId, "report_completed", session.report_id, undefined);
    await tg.answerCallbackQuery(cq.id, "Отчёт завершён");
    await resetSession(env.DB, chatId);
    await tg.sendMessage(chatId, "✅ <b>Фотоотчёт завершён</b>. Спасибо!", mainMenuKeyboard);
    return;
  }

  await tg.answerCallbackQuery(cq.id);
}
