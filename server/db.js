// Database layer — a single SQLite file via Node's built-in node:sqlite.
// No native build step, no external dependency. The schema is created on first
// run; seed.js populates starter data.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'chore-dungeon.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite has no transaction() helper, so provide a small wrapper that
// commits on success and rolls back on error.
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT,                      -- E.164, e.g. +15551234567 (Signal/Twilio)
  telegram_id   TEXT,                      -- Telegram user id, set when a roommate links themselves
  avatar_class  TEXT,                      -- optional photo URL; null → initials placeholder
  xp            INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  coins         INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT NOT NULL DEFAULT '',
  difficulty   INTEGER NOT NULL DEFAULT 1,  -- kept for future use; not surfaced in the UI
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- One row per (week, person, chore). is_final flips from 0 (Sunday proposal)
-- to 1 (Monday finalized, redistributed around anyone away).
CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start   TEXT NOT NULL,              -- ISO date of that week's Monday
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chore_id     INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'todo', -- 'todo' | 'done'
  is_final     INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  completed_via TEXT,                       -- 'web' | 'signal' | 'twilio' | 'system'
  UNIQUE(week_start, user_id, chore_id)
);

-- Who is home vs away for a given week. Absence during the Sunday->Monday
-- window triggers redistribution.
CREATE TABLE IF NOT EXISTS availability (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'home', -- 'home' | 'away'
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(week_start, user_id)
);

CREATE TABLE IF NOT EXISTS nudges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  from_user  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chore_id   INTEGER REFERENCES chores(id) ON DELETE SET NULL,
  message    TEXT
);

CREATE TABLE IF NOT EXISTS achievements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge     TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, badge)
);

-- The "Tavern Board": a human-readable activity + outbound-message log.
-- In console mode, this is where you see what WOULD have been texted.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT (datetime('now')),
  type     TEXT NOT NULL,                  -- 'message' | 'done' | 'nudge' | 'away' | 'rotation' | 'levelup' | 'system'
  user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message  TEXT NOT NULL
);

-- Simple key/value for house-wide state (e.g. weekly boss HP).
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

// Lightweight migration for databases created before telegram_id existed.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('telegram_id')) db.exec('ALTER TABLE users ADD COLUMN telegram_id TEXT');

export function logEvent(type, message, userId = null) {
  db.prepare('INSERT INTO events (type, user_id, message) VALUES (?, ?, ?)').run(type, userId, message);
}

export function getKV(k, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return row ? row.v : fallback;
}

export function setKV(k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
