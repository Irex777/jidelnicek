// ═══════════════════════════════════════════════════════════════════════
// Database — sql.js WASM SQLite
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let db;

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

function runDb(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  // Capture last_insert_rowid() before saveDb() — db.export() resets it
  const row = queryOne('SELECT last_insert_rowid() as id');
  const lastId = row ? row.id : null;
  saveDb();
  return lastId;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// ── Initialization ───────────────────────────────────────────────────
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(dataDir, 'jidelnicek.db');

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  createTables();
  migrateAccountToUsers();
  saveDb();
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sex TEXT DEFAULT NULL,
      age INTEGER DEFAULT NULL,
      weight_current REAL DEFAULT NULL,
      weight_goal REAL DEFAULT NULL,
      height REAL DEFAULT NULL,
      activity_level TEXT DEFAULT 'moderate',
      dietary_restrictions TEXT DEFAULT '',
      allergies TEXT DEFAULT '',
      favorite_foods TEXT DEFAULT '',
      calories_target INTEGER DEFAULT 2000,
      account_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      day_name TEXT DEFAULT '',
      total_calories INTEGER DEFAULT 0,
      total_protein INTEGER DEFAULT 0,
      total_carbs INTEGER DEFAULT 0,
      total_fat INTEGER DEFAULT 0,
      meals_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shopping_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date_from, date_to)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meal_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      meal_type TEXT NOT NULL,
      recipe_json TEXT NOT NULL DEFAULT '[]',
      cookware_json TEXT NOT NULL DEFAULT '[]',
      why_text TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (plan_id) REFERENCES meal_plans(id) ON DELETE CASCADE,
      UNIQUE(plan_id, meal_type)
    )
  `);
}

function migrateAccountToUsers() {
  try {
    const userCols = queryAll("PRAGMA table_info(users)");
    const hasAccountId = userCols.some(c => c.name === 'account_id');
    if (!hasAccountId) {
      db.run('ALTER TABLE users ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
      console.log('[DB] Added account_id column to users table');
    }
  } catch (e) {
    console.log('[DB] account_id migration check:', e.message);
  }
}

module.exports = { initDb, queryAll, queryOne, runDb, saveDb, getDb: () => db };
