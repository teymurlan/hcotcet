export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_CHAT_ID: string;
  EMPLOYEE_IDS?: string;
}

type State =
  | "idle"
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

interface TgUser { id: number; is_bot?: boolean; first_name: string; last_name?: string; username?: string; }
interface TgPhoto { file_id: string; file_unique_id: string; width: number; height: number; }
interface TgLocation { latitude: number; longitude: number; horizontal_accuracy?: number; }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type?: string }; text?: string; photo?: TgPhoto[]; location?: TgLocation; }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string; }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback; }
interface TgResult<T> { ok: boolean; result?: T; description?: string; }

interface Session {
  state: State;
  reportId: string;
  reportDbId: number;
  cleaner: TgUser;
  objectName: string;
  objectDbId: number;
  address: string;
  latitude?: number;
  longitude?: number;
  beforePhotos: string[];
  afterPhotos: string[];
  defects: string;
  expenseReceipt?: string;
  expenseAmount?: number;
  createdAt: string;
  beforeFinishedAt?: string;
  afterFinishedAt?: string;
  lastBotMessageId?: number;
  expiresAt: number;
}

const API = "https://api.telegram.org/bot";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_PHOTOS = 50;
const MAX_TEXT = 1500;
const MAX_HISTORY = 10;
const sessions = new Map<number, Session>();
const uiMessages = new Map<number, number>();
const processedUpdates = new Set<number>();

class Telegram {
  constructor(private readonly token: string) {}
  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const token = this.token.trim();
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
    const response = await fetch(`${API}${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.text();
    let data: TgResult<T>;
    try { data = JSON.parse(body) as TgResult<T>; } catch { throw new Error(`Telegram ${method}: invalid JSON`); }
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method}: ${response.status} ${body}`);
    return data.result as T;
  }
  sendMessage(chatId: number, text: string, markup?: unknown, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}), ...extra });
  }
  deleteMessage(chatId: number, messageId: number): Promise<unknown> { return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }); }
  answerCallbackQuery(id: string, text?: string): Promise<unknown> { return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); }
  editMessageReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<unknown> { return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup }); }
  sendMediaGroup(chatId: number, media: unknown[]): Promise<TgMessage[]> { return this.call<TgMessage[]>("sendMediaGroup", { chat_id: chatId, media }); }
}

const MAIN = {
  inline_keyboard: [
    [{ text: "🟢  НАЧАТЬ УБОРКУ", callback_data: "new" }],
    [{ text: "🔵  МОИ ОТЧЁТЫ", callback_data: "history" }, { text: "🟣  ПРОФИЛЬ", callback_data: "profile" }],
    [{ text: "🟠  ТЕКУЩАЯ УБОРКА", callback_data: "current" }],
    [{ text: "📊  МОЯ СТАТИСТИКА", callback_data: "stats" }],
    [{ text: "ℹ️  ПОМОЩЬ", callback_data: "help" }],
  ],
};
const BACK_MAIN = { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] };
const CANCEL = { inline_keyboard: [[{ text: "❌ Отменить отчёт", callback_data: "cancel" }]] };
const ADDRESS = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "back_object" }, { text: "❌ Отмена", callback_data: "cancel" }]] };
const ADDRESS_CONFIRM = { inline_keyboard: [[{ text: "🟢 Адрес верный", callback_data: "address_ok" }], [{ text: "✏️ Изменить", callback_data: "edit_address" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const DEFECTS = { inline_keyboard: [[{ text: "🟢 Дефектов нет", callback_data: "no_defects" }], [{ text: "🟠 Указать дефекты", callback_data: "write_defects" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const EXPENSES = { inline_keyboard: [[{ text: "🟠 Да, был расход", callback_data: "expense_yes" }], [{ text: "🟢 Расходов нет", callback_data: "expense_no" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const FINISH = { inline_keyboard: [[{ text: "🟢 ОТПРАВИТЬ ОТЧЁТ", callback_data: "finish_confirm" }], [{ text: "🔙 Вернуться к фото", callback_data: "continue_after" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] };
const LOCATION = { keyboard: [[{ text: "📍 Отправить геопозицию", request_location: true }]], resize_keyboard: true, one_time_keyboard: true };
const REMOVE_KEYBOARD = { remove_keyboard: true };
function photoMenu(phase: "before" | "after") { return { inline_keyboard: [[{ text: phase === "before" ? "🟢 Завершить фото ДО" : "🟢 Завершить фото ПОСЛЕ", callback_data: phase === "before" ? "finish_before" : "finish_after" }], [{ text: "❌ Отмена", callback_data: "cancel" }]] }; }

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function textOf(value: string): string { return value.trim().slice(0, MAX_TEXT); }
function now(): string { return new Date().toISOString(); }
function makeReportId(): string { const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const bytes = crypto.getRandomValues(new Uint8Array(7)); return `HC-${Array.from(bytes, b => alphabet[b % alphabet.length]).join("")}`; }
function moscow(iso: string): string { return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)); }
function elapsed(start: string, end: string): string { const min = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 60000)); return `${Math.floor(min / 60)} ч ${min % 60} мин`; }
function cleanerName(user: TgUser): string { return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || `ID ${user.id}`; }
function isEmployee(env: Env, userId: number): boolean { const admin = Number(env.ADMIN_CHAT_ID?.trim()); if (Number.isFinite(admin) && userId === admin) return true; return (env.EMPLOYEE_IDS ?? "").split(",").map(x => Number(x.trim())).filter(Number.isFinite).includes(userId); }
function getSession(chatId: number): Session | undefined { const s = sessions.get(chatId); if (!s) return; if (s.expiresAt <= Date.now()) { sessions.delete(chatId); return; } return s; }
function saveSession(chatId: number, s: Session): void { s.expiresAt = Date.now() + SESSION_TTL; sessions.set(chatId, s); }
function clearSession(chatId: number): void { sessions.delete(chatId); }
function mapsLink(s: Session): string { return s.latitude === undefined || s.longitude === undefined ? "" : `https://www.google.com/maps?q=${s.latitude},${s.longitude}`; }

async function dbEmployee(env: Env, user: TgUser): Promise<number> {
  await env.DB.prepare(`INSERT INTO employees (telegram_id, first_name, last_name, username, active) VALUES (?, ?, ?, ?, 1) ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,username=excluded.username,active=1`).bind(user.id, user.first_name, user.last_name ?? null, user.username ?? null).run();
  const row = await env.DB.prepare(`SELECT id FROM employees WHERE telegram_id=?`).bind(user.id).first<{ id: number }>();
  if (!row) throw new Error("employee not found");
  return row.id;
}
async function dbObject(env: Env, name: string, address: string, lat?: number, lon?: number): Promise<number> {
  const existing = await env.DB.prepare(`SELECT id FROM objects WHERE lower(name)=lower(?) AND (address=? OR (address IS NULL AND ? IS NULL)) ORDER BY id DESC LIMIT 1`).bind(name, address, address).first<{ id: number }>();
  if (existing) {
    await env.DB.prepare(`UPDATE objects SET latitude=?, longitude=? WHERE id=?`).bind(lat ?? null, lon ?? null, existing.id).run();
    return existing.id;
  }
  const r = await env.DB.prepare(`INSERT INTO objects (name,address,latitude,longitude) VALUES (?,?,?,?)`).bind(name, address, lat ?? null, lon ?? null).run();
  return Number(r.meta.last_row_id);
}
async function dbCreateReport(env: Env, user: TgUser, s: Omit<Session, "reportDbId" | "objectDbId">): Promise<{ employeeId: number; objectId: number; reportDbId: number }> {
  const employeeId = await dbEmployee(env, user);
  const objectId = await dbObject(env, s.objectName, s.address, s.latitude, s.longitude);
  const r = await env.DB.prepare(`INSERT INTO reports (public_id,employee_id,object_id,started_at,updated_at,status) VALUES (?,?,?,datetime('now'),datetime('now'),'in_progress')`).bind(s.reportId, employeeId, objectId).run();
  return { employeeId, objectId, reportDbId: Number(r.meta.last_row_id) };
}
async function dbPhoto(env: Env, reportDbId: number, phase: "before" | "after", fileId: string, uniqueId?: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO report_photos (report_id,phase,telegram_file_id,telegram_file_unique_id) VALUES (?,?,?,?)`).bind(reportDbId, phase, fileId, uniqueId ?? null).run();
}
async function audit(env: Env, userId: number, action: string, reportDbId?: number, details?: unknown): Promise<void> {
  try { await env.DB.prepare(`INSERT INTO audit_log (telegram_id,action,report_id,details) VALUES (?,?,?,?)`).bind(userId, action, reportDbId ?? null, details ? JSON.stringify(details) : null).run(); } catch {}
}
async function dbFinishReport(env: Env, s: Session): Promise<void> {
  await env.DB.prepare(`UPDATE reports SET completed_at=?,updated_at=?,status='completed' WHERE id=?`).bind(s.afterFinishedAt ?? now(), now(), s.reportDbId).run();
  await audit(env, s.cleaner.id, "report_completed", s.reportDbId, { publicId: s.reportId, defects: s.defects || "Нет", expense: s.expenseAmount ?? null, expenseReceipt: Boolean(s.expenseReceipt) });
}

function statusText(s: Session): string {
  const expense = s.expenseAmount === undefined ? "Нет" : `${s.expenseAmount.toFixed(2)} ₽`;
  return `<b>📋 ${escapeHtml(s.reportId)}</b>\n\n📍 <b>${escapeHtml(s.objectName)}</b>\n🏠 ${escapeHtml(s.address)}\n\n📸 ДО: <b>${s.beforePhotos.length}</b>  |  ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "не указаны")}</b>\n💸 Расходы: <b>${escapeHtml(expense)}</b>`;
}
function startAdminText(s: Session): string { const map = mapsLink(s); return `🚀 <b>НАЧАЛО УБОРКИ</b>\n\n👤 <b>${escapeHtml(cleanerName(s.cleaner))}</b>\n📍 <b>${escapeHtml(s.objectName)}</b>\n🏠 ${escapeHtml(s.address)}\n📸 Фото ДО: <b>${s.beforePhotos.length}</b>\n🆔 <code>${s.reportId}</code>${map ? `\n🗺 <a href="${map}">Открыть геопозицию</a>` : ""}`; }
function finalAdminText(s: Session): string { const end = s.afterFinishedAt ?? now(); const expense = s.expenseAmount === undefined ? "Нет" : `${s.expenseAmount.toFixed(2)} ₽`; return `🏁 <b>ОТЧЁТ ЗАВЕРШЁН</b>\n\n👤 <b>${escapeHtml(cleanerName(s.cleaner))}</b>\n📍 <b>${escapeHtml(s.objectName)}</b>\n🏠 ${escapeHtml(s.address)}\n🗓 ${moscow(end)}\n⏱ <b>${elapsed(s.beforeFinishedAt ?? s.createdAt, end)}</b>\n📸 ДО: <b>${s.beforePhotos.length}</b>  |  ПОСЛЕ: <b>${s.afterPhotos.length}</b>\n⚠️ Дефекты: <b>${escapeHtml(s.defects || "Нет")}</b>\n💸 Расходы: <b>${escapeHtml(expense)}</b>\n🆔 <code>${s.reportId}</code>`; }

async function safeDelete(tg: Telegram, chatId: number, messageId?: number): Promise<void> { if (!messageId) return; try { await tg.deleteMessage(chatId, messageId); } catch {} }
async function replaceStep(tg: Telegram, chatId: number, s: Session, text: string, markup?: unknown, extra: Record<string, unknown> = {}): Promise<void> { await safeDelete(tg, chatId, s.lastBotMessageId); await safeDelete(tg, chatId, uiMessages.get(chatId)); uiMessages.delete(chatId); const sent = await tg.sendMessage(chatId, text, markup, extra); s.lastBotMessageId = sent.message_id; saveSession(chatId, s); }
async function adminMessage(tg: Telegram, env: Env, text: string, markup?: unknown): Promise<void> { const id = Number(env.ADMIN_CHAT_ID?.trim()); if (!Number.isFinite(id)) return; try { await tg.sendMessage(id, text, markup); } catch (e) { console.error("adminMessage", e); } }
async function adminMedia(tg: Telegram, env: Env, ids: string[], caption: string): Promise<void> { const id = Number(env.ADMIN_CHAT_ID?.trim()); if (!Number.isFinite(id) || !ids.length) return; for (let i=0;i<ids.length;i+=10) { const chunk=ids.slice(i,i+10); const media=chunk.map((fileId,j)=>({type:"photo",media:fileId,...(i===0&&j===0?{caption,parse_mode:"HTML"}:{})})); try { await tg.sendMediaGroup(id,media); } catch(e) { console.error("adminMedia",e); } } }
async function mainMenu(tg: Telegram, chatId: number, title = "<b>🧹 HOUSE CLEANING</b>\n<i>Система фотоотчётов</i>"): Promise<void> { const previous=uiMessages.get(chatId); if(previous) await safeDelete(tg,chatId,previous); const sent=await tg.sendMessage(chatId,`${title}\n\n<b>Выберите действие:</b>`,MAIN); uiMessages.set(chatId,sent.message_id); }

async function startNewReport(tg: Telegram, env: Env, chatId: number, user: TgUser): Promise<void> {
  const old=getSession(chatId); if(old) await safeDelete(tg,chatId,old.lastBotMessageId);
  const base={state:"awaiting_object" as State,reportId:makeReportId(),cleaner:user,objectName:"",address:"",beforePhotos:[],afterPhotos:[],defects:"",createdAt:now(),expiresAt:Date.now()+SESSION_TTL};
  const db=await dbCreateReport(env,user,base);
  const s:Session={...base,reportDbId:db.reportDbId,objectDbId:db.objectId}; saveSession(chatId,s);
  await audit(env,user.id,"report_started",s.reportDbId,{publicId:s.reportId});
  await replaceStep(tg,chatId,s,`<b>🧹 НОВЫЙ ФОТООТЧЁТ</b>\n\n<b>Шаг 1 из 6 · Объект</b>\n\nВведите название или номер объекта.\n\n<i>Например: Объект №123</i>`,CANCEL);
}

async function showHistory(tg: Telegram, env: Env, chatId: number, userId: number): Promise<void> {
  const employee=await env.DB.prepare(`SELECT id FROM employees WHERE telegram_id=?`).bind(userId).first<{id:number}>();
  if(!employee){ await mainMenu(tg,chatId,"<b>🔵 МОИ ОТЧЁТЫ</b>\n\nПока завершённых отчётов нет."); return; }
  const rows=await env.DB.prepare(`SELECT r.public_id,r.completed_at,o.name object_name,o.address,COUNT(CASE WHEN p.phase='before' THEN 1 END) before_count,COUNT(CASE WHEN p.phase='after' THEN 1 END) after_count FROM reports r JOIN objects o ON o.id=r.object_id LEFT JOIN report_photos p ON p.report_id=r.id WHERE r.employee_id=? AND r.status='completed' GROUP BY r.id ORDER BY r.completed_at DESC LIMIT ?`).bind(employee.id,MAX_HISTORY).all<any>();
  if(!rows.results?.length){ await mainMenu(tg,chatId,"<b>🔵 МОИ ОТЧЁТЫ</b>\n\nЗавершённых отчётов пока нет."); return; }
  const lines=rows.results.map((r:any,i:number)=>`${i+1}. <b>${escapeHtml(r.public_id)}</b>\n📍 ${escapeHtml(r.object_name)}\n📸 ДО ${r.before_count} · ПОСЛЕ ${r.after_count}\n🗓 ${r.completed_at ? moscow(r.completed_at) : "—"}`).join("\n\n");
  await mainMenu(tg,chatId,`<b>🔵 МОИ ОТЧЁТЫ</b>\n\n${lines}`);
}
async function showProfile(tg: Telegram, env: Env, chatId: number, user: TgUser): Promise<void> {
  const row=await env.DB.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END) completed FROM reports r JOIN employees e ON e.id=r.employee_id WHERE e.telegram_id=?`).bind(user.id).first<any>();
  await mainMenu(tg,chatId,`<b>🟣 ПРОФИЛЬ</b>\n\n👤 <b>${escapeHtml(cleanerName(user))}</b>\n🆔 <code>${user.id}</code>\n\n📋 Всего отчётов: <b>${Number(row?.total??0)}</b>\n✅ Завершено: <b>${Number(row?.completed??0)}</b>`);
}
async function showStats(tg: Telegram, env: Env, chatId: number, userId: number): Promise<void> {
  const row=await env.DB.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN r.status='in_progress' THEN 1 ELSE 0 END) active FROM reports r JOIN employees e ON e.id=r.employee_id WHERE e.telegram_id=?`).bind(userId).first<any>();
  const photos=await env.DB.prepare(`SELECT COUNT(*) count FROM report_photos p JOIN reports r ON r.id=p.report_id JOIN employees e ON e.id=r.employee_id WHERE e.telegram_id=?`).bind(userId).first<{count:number}>();
  await mainMenu(tg,chatId,`<b>📊 МОЯ СТАТИСТИКА</b>\n\n📋 Всего отчётов: <b>${Number(row?.total??0)}</b>\n✅ Завершено: <b>${Number(row?.completed??0)}</b>\n🟠 В работе: <b>${Number(row?.active??0)}</b>\n📸 Загружено фото: <b>${Number(photos?.count??0)}</b>`);
}
async function showCurrent(tg: Telegram, chatId: number): Promise<void> { const s=getSession(chatId); if(!s){ await mainMenu(tg,chatId,"<b>🟠 ТЕКУЩАЯ УБОРКА</b>\n\nАктивной уборки нет.\n\nНажмите «Начать уборку», чтобы создать новый отчёт."); return; } await replaceStep(tg,chatId,s,`<b>🟠 ТЕКУЩАЯ УБОРКА</b>\n\n${statusText(s)}\n\n<b>Этап:</b> ${stateLabel(s.state)}`,stateKeyboard(s.state)); }
function stateLabel(state:State):string { const map:Record<State,string>={idle:"Главное меню",awaiting_object:"Ожидается объект",awaiting_address:"Ожидается адрес",confirm_address:"Проверка адреса",awaiting_location:"Геопозиция",before_photos:"Фото ДО",awaiting_defects:"Дефекты",after_photos:"Фото ПОСЛЕ",awaiting_expense_decision:"Расходы",awaiting_receipt:"Чек",awaiting_expense_amount:"Сумма расхода",confirm_finish:"Проверка отчёта"}; return map[state]; }
function stateKeyboard(state:State):unknown { if(state==="before_photos")return photoMenu("before"); if(state==="after_photos")return photoMenu("after"); if(state==="awaiting_defects")return DEFECTS; if(state==="awaiting_expense_decision")return EXPENSES; if(state==="confirm_finish")return FINISH; return CANCEL; }

async function handleText(tg: Telegram, env: Env, msg: TgMessage): Promise<void> {
  const user=msg.from;if(!user)return;const chatId=msg.chat.id;const text=textOf(msg.text??"");
  if(!isEmployee(env,user.id)){if(text==="/start")await tg.sendMessage(chatId,"⛔ <b>Доступ закрыт.</b>\n\nБот доступен только сотрудникам House Cleaning.");return;}
  const current=getSession(chatId);
  if(["/start","/menu"].includes(text)){if(current)await safeDelete(tg,chatId,current.lastBotMessageId);clearSession(chatId);await mainMenu(tg,chatId,"<b>🧹 HOUSE CLEANING</b>\n<i>Добро пожаловать в систему фотоотчётов</i>");await safeDelete(tg,chatId,msg.message_id);return;}
  if(text==="/new"){await startNewReport(tg,env,chatId,user);await safeDelete(tg,chatId,msg.message_id);return;}
  if(text==="/cancel"){if(current)await safeDelete(tg,chatId,current.lastBotMessageId);clearSession(chatId);await mainMenu(tg,chatId,"<b>❌ Отчёт отменён</b>");await safeDelete(tg,chatId,msg.message_id);return;}
  if(text==="/status"){await showCurrent(tg,chatId);await safeDelete(tg,chatId,msg.message_id);return;}
  if(text==="/help"){await mainMenu(tg,chatId,"<b>ℹ️ ПОМОЩЬ</b>\n\n<b>Как создать отчёт</b>\n1. Объект\n2. Адрес\n3. Геопозиция\n4. Фото ДО\n5. Дефекты\n6. Фото ПОСЛЕ\n7. Расходы\n8. Проверка и отправка\n\nФото и данные отчётов сохраняются в базе D1. Старые отчёты не удаляются.");await safeDelete(tg,chatId,msg.message_id);return;}
  const s=getSession(chatId);if(!s){await mainMenu(tg,chatId,"<b>Начнём новую уборку?</b>");await safeDelete(tg,chatId,msg.message_id);return;}
  switch(s.state){
    case "awaiting_object": if(text){s.objectName=text;s.state="awaiting_address";await replaceStep(tg,chatId,s,`<b>📍 Шаг 2 из 6 · Адрес</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\n\nВведите полный адрес.`,ADDRESS);}break;
    case "awaiting_address": if(text){s.address=text;s.state="confirm_address";await replaceStep(tg,chatId,s,`<b>📍 ПРОВЕРЬТЕ АДРЕС</b>\n\n<b>${escapeHtml(s.objectName)}</b>\n${escapeHtml(s.address)}\n\nАдрес указан верно?`,ADDRESS_CONFIRM);}break;
    case "awaiting_defects": if(text){s.defects=text;s.state="after_photos";await env.DB.prepare(`UPDATE objects SET latitude=?,longitude=? WHERE id=?`).bind(s.latitude??null,s.longitude??null,s.objectDbId).run();await audit(env,user.id,"defects_added",s.reportDbId,{text});await adminMessage(tg,env,`⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 ${escapeHtml(text)}`);await replaceStep(tg,chatId,s,`<b>📸 Шаг 4 из 6 · Фото ПОСЛЕ</b>\n\nОтправляйте фото результата.\n\nФото ПОСЛЕ: <b>0</b>`,photoMenu("after"));}break;
    case "awaiting_expense_amount": {const amount=Number(text.replace(/\s/g,"").replace("₽","").replace(",","."));if(Number.isFinite(amount)&&amount>0&&amount<=100000){s.expenseAmount=Math.round(amount*100)/100;s.state="confirm_finish";await replaceStep(tg,chatId,s,`<b>📋 Шаг 6 из 6 · ПРОВЕРКА</b>\n\n${statusText(s)}\n\n<b>Всё верно?</b>`,FINISH);}else await replaceStep(tg,chatId,s,"Введите сумму числом, например <b>850</b>.",CANCEL);break;}
    default: await replaceStep(tg,chatId,s,`⚠️ Сейчас ожидается: <b>${stateLabel(s.state)}</b>\n\nИспользуйте кнопку текущего шага.`,stateKeyboard(s.state));
  }
  await safeDelete(tg,chatId,msg.message_id);
}

async function handleLocation(tg: Telegram, env: Env, chatId: number, msg: TgMessage): Promise<void> { const s=getSession(chatId);if(!s||s.state!=="awaiting_location"||!msg.location)return;s.latitude=msg.location.latitude;s.longitude=msg.location.longitude;s.state="before_photos";await env.DB.prepare(`UPDATE objects SET latitude=?,longitude=? WHERE id=?`).bind(s.latitude,s.longitude,s.objectDbId).run();await audit(env,msg.from?.id??0,"location_added",s.reportDbId,{latitude:s.latitude,longitude:s.longitude});await safeDelete(tg,chatId,s.lastBotMessageId);const sent=await tg.sendMessage(chatId,`<b>📸 Шаг 3 из 6 · Фото ДО</b>\n\n📍 Геопозиция получена\n\nОтправьте фотографии объекта ДО уборки.\n\nФото ДО: <b>0</b>`,photoMenu("before"),{reply_markup:REMOVE_KEYBOARD});s.lastBotMessageId=sent.message_id;saveSession(chatId,s);await safeDelete(tg,chatId,msg.message_id); }

async function handlePhoto(tg: Telegram, env: Env, chatId: number, msg: TgMessage): Promise<void> { const s=getSession(chatId);const photo=msg.photo?.at(-1);if(!s||!photo)return;switch(s.state){case "before_photos":if(s.beforePhotos.length>=MAX_PHOTOS){await replaceStep(tg,chatId,s,`⚠️ Достигнут лимит ${MAX_PHOTOS} фото ДО.`,photoMenu("before"));break;}s.beforePhotos.push(photo.file_id);await dbPhoto(env,s.reportDbId,"before",photo.file_id,photo.file_unique_id);await audit(env,msg.from?.id??0,"before_photo_added",s.reportDbId,{count:s.beforePhotos.length});await replaceStep(tg,chatId,s,`<b>📸 Фото ДО</b>\n\nПринято: <b>${s.beforePhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`,photoMenu("before"));break;case "after_photos":if(s.afterPhotos.length>=MAX_PHOTOS){await replaceStep(tg,chatId,s,`⚠️ Достигнут лимит ${MAX_PHOTOS} фото ПОСЛЕ.`,photoMenu("after"));break;}s.afterPhotos.push(photo.file_id);await dbPhoto(env,s.reportDbId,"after",photo.file_id,photo.file_unique_id);await audit(env,msg.from?.id??0,"after_photo_added",s.reportDbId,{count:s.afterPhotos.length});await replaceStep(tg,chatId,s,`<b>📸 Фото ПОСЛЕ</b>\n\nПринято: <b>${s.afterPhotos.length}</b>\n\nОтправьте следующее фото или завершите загрузку.`,photoMenu("after"));break;case "awaiting_receipt":s.expenseReceipt=photo.file_id;s.state="awaiting_expense_amount";await audit(env,msg.from?.id??0,"receipt_added",s.reportDbId);await replaceStep(tg,chatId,s,"<b>🧾 ЧЕК ПРИНЯТ</b>\n\nВведите сумму расхода, например <b>850</b>.",CANCEL);break;default:await replaceStep(tg,chatId,s,"⚠️ Фото сейчас не ожидается.",stateKeyboard(s.state));}await safeDelete(tg,chatId,msg.message_id); }

async function handleCallback(tg: Telegram, env: Env, cq: TgCallback): Promise<void> {
  try{await tg.answerCallbackQuery(cq.id);}catch{}
  const chatId=cq.message?.chat.id;if(!chatId||!isEmployee(env,cq.from.id))return;const data=cq.data??"";const s=getSession(chatId);
  try{switch(data){
    case "menu": if(s)await safeDelete(tg,chatId,s.lastBotMessageId);clearSession(chatId);await mainMenu(tg,chatId);return;
    case "new": await startNewReport(tg,env,chatId,cq.from);return;
    case "history": await showHistory(tg,env,chatId,cq.from.id);return;
    case "profile": await showProfile(tg,env,chatId,cq.from);return;
    case "stats": await showStats(tg,env,chatId,cq.from.id);return;
    case "current": await showCurrent(tg,chatId);return;
    case "help": await mainMenu(tg,chatId,"<b>ℹ️ ПОМОЩЬ</b>\n\n<b>Порядок отчёта</b>\n🧹 Объект → 📍 адрес → 📍 геопозиция → 📸 ДО → ⚠️ дефекты → 📸 ПОСЛЕ → 💸 расходы → 🏁 отправка\n\nМожно отменить отчёт на любом шаге. Фото сохраняются в D1 и не удаляются при обновлении бота.");return;
    case "cancel": if(s){await env.DB.prepare(`UPDATE reports SET status='cancelled',updated_at=? WHERE id=? AND status='in_progress'`).bind(now(),s.reportDbId).run();await audit(env,cq.from.id,"report_cancelled",s.reportDbId,{publicId:s.reportId});await safeDelete(tg,chatId,s.lastBotMessageId);}clearSession(chatId);await mainMenu(tg,chatId,"<b>❌ Отчёт отменён</b>\n\nСохранённые фото и история базы не удалены.");return;
    case "back_object": if(s){s.state="awaiting_object";await replaceStep(tg,chatId,s,"<b>🧹 Шаг 1 из 6 · Объект</b>\n\nВведите название или номер объекта.",CANCEL);}return;
    case "address_ok": if(s?.state!=="confirm_address")return;s.objectDbId=await dbObject(env,s.objectName,s.address);s.state="awaiting_location";await replaceStep(tg,chatId,s,`<b>📍 Шаг 3 из 6 · Геопозиция</b>\n\nОбъект: <b>${escapeHtml(s.objectName)}</b>\n\nНажмите кнопку ниже и отправьте текущую геопозицию.`,LOCATION);return;
    case "edit_address": if(s?.state!=="confirm_address")return;s.state="awaiting_address";await replaceStep(tg,chatId,s,"<b>📍 Изменить адрес</b>\n\nВведите адрес заново.",ADDRESS);return;
    case "finish_before": if(s?.state!=="before_photos")return;if(!s.beforePhotos.length){await replaceStep(tg,chatId,s,"⚠️ Нужно отправить хотя бы одно фото ДО.",photoMenu("before"));return;}s.beforeFinishedAt=now();s.state="awaiting_defects";saveSession(chatId,s);await audit(env,cq.from.id,"before_completed",s.reportDbId,{count:s.beforePhotos.length});await adminMessage(tg,env,startAdminText(s));await adminMedia(tg,env,s.beforePhotos,`🚀 <b>Фото ДО · ${s.reportId}</b>`);await replaceStep(tg,chatId,s,"<b>⚠️ Шаг 4 из 6 · Дефекты</b>\n\nЕсть повреждения или дефекты ДО уборки?",DEFECTS);return;
    case "no_defects": if(s?.state!=="awaiting_defects")return;s.defects="Нет дефектов";s.state="after_photos";await audit(env,cq.from.id,"no_defects",s.reportDbId);await adminMessage(tg,env,`⚠️ <b>ДЕФЕКТЫ ДО УБОРКИ</b>\n\n${startAdminText(s)}\n\n📝 <b>Нет дефектов</b>`);await replaceStep(tg,chatId,s,"<b>📸 Шаг 4 из 6 · Фото ПОСЛЕ</b>\n\nОтправляйте фото результата.\n\nФото ПОСЛЕ: <b>0</b>",photoMenu("after"));return;
    case "write_defects": if(s?.state!=="awaiting_defects")return;await replaceStep(tg,chatId,s,"<b>✏️ ОПИШИТЕ ДЕФЕКТЫ</b>\n\nНапишите одним сообщением, что было повреждено или уже имело дефект до уборки.",CANCEL);return;
    case "finish_after": if(s?.state!=="after_photos")return;if(!s.afterPhotos.length){await replaceStep(tg,chatId,s,"⚠️ Нужно отправить хотя бы одно фото ПОСЛЕ.",photoMenu("after"));return;}s.afterFinishedAt=now();s.state="awaiting_expense_decision";await audit(env,cq.from.id,"after_completed",s.reportDbId,{count:s.afterPhotos.length});await replaceStep(tg,chatId,s,"<b>💸 Шаг 5 из 6 · РАСХОДЫ</b>\n\nБыли расходы на химию, такси или другие нужды?",EXPENSES);return;
    case "expense_yes": if(s?.state!=="awaiting_expense_decision")return;s.state="awaiting_receipt";await replaceStep(tg,chatId,s,"<b>🧾 ФОТО ЧЕКА</b>\n\nПришлите фото чека. После него бот попросит сумму.",CANCEL);return;
    case "expense_no": if(s?.state!=="awaiting_expense_decision")return;s.expenseAmount=undefined;s.state="confirm_finish";await replaceStep(tg,chatId,s,`<b>📋 Шаг 6 из 6 · ПРОВЕРКА</b>\n\n${statusText(s)}\n\n<b>Всё верно?</b>`,FINISH);return;
    case "continue_after": if(s?.state!=="confirm_finish")return;s.state="after_photos";s.afterFinishedAt=undefined;await replaceStep(tg,chatId,s,`<b>📸 ФОТО ПОСЛЕ</b>\n\nПринято: <b>${s.afterPhotos.length}</b>`,photoMenu("after"));return;
    case "finish_confirm": if(s?.state!=="confirm_finish")return;if(!s.beforePhotos.length||!s.afterPhotos.length){await replaceStep(tg,chatId,s,"⚠️ Нельзя отправить отчёт без фото ДО и ПОСЛЕ.",FINISH);return;}s.afterFinishedAt=s.afterFinishedAt??now();await dbFinishReport(env,s);await adminMessage(tg,env,finalAdminText(s),{inline_keyboard:[[{text:"🟢 Принять отчёт",callback_data:`accept:${s.reportId}`}],[{text:"💬 Связаться с клинером",url:`tg://user?id=${s.cleaner.id}`}]]});await adminMedia(tg,env,s.afterPhotos,`🏁 <b>Фото ПОСЛЕ · ${s.reportId}</b>`);if(s.expenseReceipt)await adminMedia(tg,env,[s.expenseReceipt],`🧾 <b>Чек · ${s.reportId}</b>`);await safeDelete(tg,chatId,s.lastBotMessageId);clearSession(chatId);await mainMenu(tg,chatId,`<b>🏁 ОТЧЁТ ОТПРАВЛЕН</b>\n\nНомер: <code>${s.reportId}</code>\n\nДанные и фотографии сохранены.`);return;
    default:
      if(data==="noop")return;
      if(data.startsWith("accept:")&&chatId===Number(env.ADMIN_CHAT_ID?.trim())){await tg.editMessageReplyMarkup(chatId,cq.message?.message_id??0,{inline_keyboard:[[{text:"Принято ✅",callback_data:"noop"}]]});return;}
  }}catch(error){console.error("callback handler",error);try{await tg.sendMessage(chatId,"⚠️ Не удалось выполнить действие. Нажмите /start и повторите.");}catch{}}
}

function alreadyProcessed(id:number):boolean{if(processedUpdates.has(id))return true;processedUpdates.add(id);if(processedUpdates.size>5000){const first=processedUpdates.values().next().value;if(typeof first==="number")processedUpdates.delete(first);}return false;}
function validWebhook(request:Request,env:Env):boolean{const secret=env.TELEGRAM_WEBHOOK_SECRET?.trim();return !secret||request.headers.get("X-Telegram-Bot-Api-Secret-Token")===secret;}

export default { async fetch(request:Request,env:Env):Promise<Response>{const url=new URL(request.url);if(request.method==="GET"&&url.pathname==="/")return new Response("House Cleaning bot is running",{status:200});if(request.method==="GET"&&url.pathname==="/health")return Response.json({ok:true,worker:"hcotcet",database:"D1"});if(url.pathname!=="/webhook")return new Response("Not Found",{status:404});if(request.method!=="POST")return new Response("Method Not Allowed",{status:405});if(!validWebhook(request,env))return new Response("Forbidden",{status:403});let update:TgUpdate;try{update=await request.json() as TgUpdate}catch{return new Response("Bad Request",{status:400});}if(!update||typeof update.update_id!=="number")return new Response("Bad Request",{status:400});if(alreadyProcessed(update.update_id))return new Response("OK",{status:200});const tg=new Telegram(env.TELEGRAM_BOT_TOKEN);try{if(update.callback_query)await handleCallback(tg,env,update.callback_query);else if(update.message?.from&&isEmployee(env,update.message.from.id)){if(update.message.location)await handleLocation(tg,env,update.message.chat.id,update.message);else if(update.message.photo?.length)await handlePhoto(tg,env,update.message.chat.id,update.message);else if(update.message.text!==undefined)await handleText(tg,env,update.message);}else if(update.message?.text!==undefined)await handleText(tg,env,update.message);}catch(error){console.error("webhook processing",error);}return new Response("OK",{status:200});} };