import type { TgUser } from "./telegram";

export interface Session {
  telegram_id: number;
  state: string | null;
  report_id: number | null;
  object_name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function ensureEmployee(db: D1Database, user: TgUser) {
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

export async function getSession(db: D1Database, telegramId: number): Promise<Session> {
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

export async function saveSession(db: D1Database, session: Session) {
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

export async function resetSession(db: D1Database, telegramId: number) {
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

export async function createObject(db: D1Database, name: string, address: string) {
  const res = await db
    .prepare(`INSERT INTO objects (name, address) VALUES (?, ?)`)
    .bind(name, address)
    .run();
  return res.meta.last_row_id as number;
}

function generatePublicId() {
  // Короткий человекочитаемый номер отчёта, например HC-8K3F2Q
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `HC-${code}`;
}

export async function createReport(db: D1Database, employeeId: number, objectId: number) {
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

export async function addPhoto(
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

export async function countPhotos(db: D1Database, reportId: number, phase: "before" | "after") {
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM report_photos WHERE report_id = ? AND phase = ?`)
    .bind(reportId, phase)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function completeReport(db: D1Database, reportId: number) {
  await db
    .prepare(
      `UPDATE reports SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(reportId)
    .run();
}

export async function listRecentReports(db: D1Database, employeeId: number, limit = 5) {
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

export async function logAction(
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
