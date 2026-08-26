-- House Cleaning — Фотоотчёты
-- Схема базы данных D1
-- Эта схема уже применена к базе house-cleaning-reports.
-- Файл хранится в репозитории как источник правды на будущее
-- (например, если понадобится пересоздать базу или завести staging-копию).

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  object_id INTEGER NOT NULL REFERENCES objects(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'in_progress'
);

CREATE TABLE IF NOT EXISTS sessions (
  telegram_id INTEGER PRIMARY KEY,
  state TEXT,
  report_id INTEGER,
  object_name TEXT,
  address TEXT,
  latitude REAL,
  longitude REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS report_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  phase TEXT NOT NULL CHECK (phase IN ('before','after')),
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER,
  action TEXT,
  report_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_employee ON reports(employee_id);
CREATE INDEX IF NOT EXISTS idx_report_photos_report ON report_photos(report_id);
