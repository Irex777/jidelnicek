// ═══════════════════════════════════════════════════════════════════════
// Jídelníček v3 — Day-by-day generation, SQLite (sql.js WASM), SSE
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database (sql.js — WASM SQLite) ──────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, 'jidelnicek.db');
let db;

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON`);

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
      created_at TEXT DEFAULT (datetime('now'))
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

  saveDb();
}

// ── Query helpers ────────────────────────────────────────────────────
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
  const results = queryAll(sql, params);
  return results[0] || null;
}

function runDb(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  // Must capture last_insert_rowid() BEFORE saveDb() because db.export() resets it
  const row = queryOne('SELECT last_insert_rowid() as id');
  const lastId = row ? row.id : null;
  saveDb();
  return lastId;
}

// ── AI Client ────────────────────────────────────────────────────────
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.z.ai/api/coding/paas/v4';
const AI_MODEL = process.env.AI_MODEL || 'glm-5-turbo';
const AI_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS) || 4000;
const ai = new OpenAI({ apiKey: process.env.ZAI_API_KEY, baseURL: AI_BASE_URL });
console.log(`[AI] model=${AI_MODEL} baseURL=${AI_BASE_URL} max_tokens=${AI_MAX_TOKENS}`);

// ── Helpers ──────────────────────────────────────────────────────────
const DAY_NAMES_CS = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
const MEAL_TYPES_CS = { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' };

function calcBMR(u) {
  if (!u.weight_current || !u.height || !u.age || !u.sex) return 2000;
  return u.sex === 'male'
    ? Math.round(10 * u.weight_current + 6.25 * u.height - 5 * u.age + 5)
    : Math.round(10 * u.weight_current + 6.25 * u.height - 5 * u.age - 161);
}

function calcTDEE(bmr, level) {
  const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  return Math.round(bmr * (multipliers[level] || 1.55));
}

function calcCaloriesTarget(u) {
  const bmr = calcBMR(u);
  const tdee = calcTDEE(bmr, u.activity_level || 'moderate');
  return (u.weight_goal && u.weight_current && u.weight_goal < u.weight_current) ? tdee - 500 : tdee;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function getDayIndex(dateStr) {
  const d = new Date(dateStr);
  const jsDay = d.getDay(); // 0=Sun, 1=Mon...6=Sat
  return jsDay === 0 ? 6 : jsDay - 1; // Convert to 0=Mon...6=Sun
}

function parseDayPlan(raw) {
  let content = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const jsonStart = content.indexOf('{');
  if (jsonStart > 0) content = content.substring(jsonStart);
  return JSON.parse(content);
}

function planToJSON(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    date: row.date,
    day_name: row.day_name,
    total_calories: row.total_calories,
    total_protein: row.total_protein,
    total_carbs: row.total_carbs,
    total_fat: row.total_fat,
    meals: JSON.parse(row.meals_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── AI Generation (single day) ──────────────────────────────────────
async function generateDayPlan(user, date, previousMealNames) {
  const dayIdx = getDayIndex(date);
  const dayName = DAY_NAMES_CS[dayIdx];
  const targetCal = user.calories_target || 2000;

  const antiRepeat = previousMealNames.length > 0
    ? `\nJiž navržená jídla (NEOPAKUJ stejná jména): ${previousMealNames.join(', ')}`
    : '';

  const prompt = `Vytvoř jídelníček pro ${dayName} jako JSON. Uživatel: ${user.name}, ${user.sex === 'male' ? 'muž' : user.sex === 'female' ? 'žena' : '?'}, ${user.age || '?'}let, ${user.weight_current || '?'}kg→${user.weight_goal || '?'}kg. Aktivita: ${user.activity_level || 'moderate'}, diety: ${user.dietary_restrictions || 'žádné'}, alergie: ${user.allergies || 'žádné'}, oblíbené: ${user.favorite_foods || '-'}. Cíl: ${targetCal}kcal.${antiRepeat}

Vrať POUZE JSON: {"day":"${dayName}","total_calories":N,"total_protein":N,"total_carbs":N,"total_fat":N,"meals":{"breakfast":{"name":"","calories":N,"protein":N,"carbs":N,"fat":N,"ingredients":["s množstvím"],"prep_time":"N min"},"morning_snack":{...},"lunch":{...},"afternoon_snack":{...},"dinner":{...}}}
Pravidla: české suroviny, makro 30P/40C/30F, kalorie rozděleny 22/8/30/8/32%, max 30min příprava. Pouze JSON.`;

  const messages = [
    { role: 'system', content: 'Output directly. No reasoning. No thinking. Just respond with the JSON immediately.' },
    { role: 'user', content: prompt }
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    const completion = await ai.chat.completions.create(
      { model: AI_MODEL, messages, temperature: 0.8, max_tokens: AI_MAX_TOKENS },
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    const raw = (completion.choices[0].message.content || '').trim();
    if (!raw) {
      throw new Error('AI returned empty content (model may have used all tokens on reasoning). Try a non-thinking model.');
    }
    return parseDayPlan(raw);
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function extractMealNames(planData) {
  if (!planData || !planData.meals) return [];
  return Object.values(planData.meals).map(m => m.name).filter(Boolean);
}

// ── API: Health ──────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', model: AI_MODEL, db: 'sqlite-wasm' });
});

// ── API: Users ───────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(queryAll('SELECT * FROM users ORDER BY id'));
});

app.post('/api/users', (req, res) => {
  const d = req.body;
  if (!d.name) return res.status(400).json({ error: 'Name is required' });

  // Calculate calories target
  const tempUser = { ...d, activity_level: d.activity_level || 'moderate' };
  const calories_target = calcCaloriesTarget(tempUser);

  const newUserId = runDb(
    `INSERT INTO users (name, sex, age, weight_current, weight_goal, height, activity_level, dietary_restrictions, allergies, favorite_foods, calories_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.name, d.sex || null, d.age || null,
     d.weight_current || null, d.weight_goal || null, d.height || null,
     d.activity_level || 'moderate', d.dietary_restrictions || '',
     d.allergies || '', d.favorite_foods || '', calories_target]
  );
  const user = queryOne('SELECT * FROM users WHERE id = ?', [newUserId]);
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const tempUser = { ...d, activity_level: d.activity_level || 'moderate' };
  const calories_target = calcCaloriesTarget(tempUser);

  runDb(
    `UPDATE users SET name=?, sex=?, age=?, weight_current=?, weight_goal=?, height=?, activity_level=?, dietary_restrictions=?, allergies=?, favorite_foods=?, calories_target=? WHERE id=?`,
    [d.name, d.sex || null, d.age || null,
     d.weight_current || null, d.weight_goal || null, d.height || null,
     d.activity_level || 'moderate', d.dietary_restrictions || '',
     d.allergies || '', d.favorite_foods || '', calories_target, id]
  );
  const user = queryOne('SELECT * FROM users WHERE id = ?', [id]);
  user ? res.json(user) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/users/:id', (req, res) => {
  runDb('DELETE FROM users WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ ok: true });
});

// ── API: Get plans ───────────────────────────────────────────────────
app.get('/api/plan/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const from = req.query.from;
  const to = req.query.to;

  if (from && to) {
    const rows = queryAll('SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, from, to]);
    return res.json(rows.map(planToJSON));
  }

  // Return all plans for user
  const rows = queryAll('SELECT * FROM meal_plans WHERE user_id = ? ORDER BY date DESC', [userId]);
  res.json(rows.map(planToJSON));
});

// ── API: Edit a meal plan ────────────────────────────────────────────
app.put('/api/plan/:planId', (req, res) => {
  const planId = parseInt(req.params.planId);
  const d = req.body;
  const existing = queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]);
  if (!existing) return res.status(404).json({ error: 'Plan not found' });

  let meals = JSON.parse(existing.meals_json);
  if (d.meals) meals = d.meals;

  // Recalculate totals
  let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;
  for (const meal of Object.values(meals)) {
    totalCal += meal.calories || 0;
    totalP += meal.protein || 0;
    totalC += meal.carbs || 0;
    totalF += meal.fat || 0;
  }

  runDb(
    `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
    [d.day_name || existing.day_name,
     d.total_calories || totalCal,
     d.total_protein || totalP,
     d.total_carbs || totalC,
     d.total_fat || totalF,
     JSON.stringify(meals),
     planId]
  );
  res.json(planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId])));
});

// ── API: Delete a plan ───────────────────────────────────────────────
app.delete('/api/plan/:planId', (req, res) => {
  runDb('DELETE FROM meal_plans WHERE id = ?', [parseInt(req.params.planId)]);
  res.json({ ok: true });
});

// ── API: Generate single day ─────────────────────────────────────────
app.post('/api/generate-day', async (req, res) => {
  const { userId, date } = req.body;
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });

  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get previous 3-4 days of meal names for anti-repetition
  const prevDays = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(date, -i);
    const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
    if (prevPlan) {
      prevDays.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
    }
  }

  try {
    const dayPlan = await generateDayPlan(user, date, prevDays);
    const dayIdx = getDayIndex(date);
    const dayName = DAY_NAMES_CS[dayIdx];

    const mealsJson = JSON.stringify(dayPlan.meals);

    // Upsert
    const existing = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);
    if (existing) {
      runDb(
        `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
        [dayPlan.day || dayName,
         dayPlan.total_calories || 0,
         dayPlan.total_protein || 0,
         dayPlan.total_carbs || 0,
         dayPlan.total_fat || 0,
         mealsJson,
         existing.id]
      );
      return res.json(planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [existing.id])));
    } else {
      const newPlanId = runDb(
        `INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, date, dayPlan.day || dayName,
         dayPlan.total_calories || 0, dayPlan.total_protein || 0,
         dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson]
      );
      return res.json(planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [newPlanId])));
    }
  } catch (err) {
    console.error(`[AI] generate-day error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── Background generation status (in-memory) ────────────────────────
const genStatus = new Map(); // key: "userId:weekStart", value: { status, completed, total, errors[] }

function getGenKey(userId, weekStart) {
  return `${userId}:${weekStart}`;
}

// Core generation logic — no res dependency, runs fully in background
async function runWeekGeneration(userId, weekStart) {
  const key = getGenKey(userId, weekStart);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    genStatus.set(key, { status: 'error', completed: 0, total: 7, errors: ['User not found'] });
    return;
  }

  // Build array of 7 dates
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(weekStart, i));
  }

  // Get previous meal names for anti-repetition
  const prevMealNames = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(weekStart, -i);
    const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
    if (prevPlan) {
      prevMealNames.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
    }
  }

  // Initialize status
  genStatus.set(key, { status: 'generating', completed: 0, total: 7, errors: [] });
  console.log(`[GEN] Started background week generation for ${key}`);

  // Fire all 7 in parallel
  const promises = dates.map((date, idx) => {
    const dayIdx = getDayIndex(date);
    const dayName = DAY_NAMES_CS[dayIdx];

    return generateDayPlan(user, date, prevMealNames)
      .then(dayPlan => {
        const mealsJson = JSON.stringify(dayPlan.meals);

        // Upsert into DB
        const existing = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);
        let planId;
        if (existing) {
          runDb(
            `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
            [dayPlan.day || dayName,
             dayPlan.total_calories || 0,
             dayPlan.total_protein || 0,
             dayPlan.total_carbs || 0,
             dayPlan.total_fat || 0,
             mealsJson,
             existing.id]
          );
          planId = existing.id;
        } else {
          planId = runDb(
            `INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, date, dayPlan.day || dayName,
             dayPlan.total_calories || 0, dayPlan.total_protein || 0,
             dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson]
          );
        }

        console.log(`[GEN] ${key} day ${idx + 1}/7 done: ${dayName} ${dayPlan.total_calories} kcal`);

        // Update status atomically
        const s = genStatus.get(key);
        if (s) {
          s.completed++;
          genStatus.set(key, s);
        }
      })
      .catch(err => {
        console.error(`[GEN] ${key} day ${idx + 1}/7 failed: ${err.message}`);
        const s = genStatus.get(key);
        if (s) {
          s.errors.push({ day: idx, name: dayName, date, error: err.message });
          s.completed++;
          genStatus.set(key, s);
        }
      });
  });

  await Promise.all(promises);

  // Mark complete
  const final = genStatus.get(key);
  if (final) {
    final.status = 'complete';
    genStatus.set(key, final);
  }
  console.log(`[GEN] Finished background week generation for ${key}: ${final?.completed || '?'}/7 done`);
}

// ── API: Generate week async (fire & forget, returns immediately) ────
app.post('/api/generate-week-async', (req, res) => {
  const { userId, weekStart } = req.body;
  if (!userId || !weekStart) return res.status(400).json({ error: 'userId and weekStart required' });

  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const key = getGenKey(userId, weekStart);
  const existing = genStatus.get(key);

  // If already generating, return current status
  if (existing && existing.status === 'generating') {
    return res.json({ status: 'already_generating', key, completed: existing.completed, total: existing.total });
  }

  // Kick off background generation (no await — fire and forget)
  runWeekGeneration(userId, weekStart).catch(err => {
    console.error(`[GEN] Fatal error for ${key}:`, err.message);
    genStatus.set(key, { status: 'error', completed: 0, total: 7, errors: [{ error: err.message }] });
  });

  res.json({ status: 'started', key, completed: 0, total: 7 });
});

// ── API: Generation status (poll endpoint) ───────────────────────────
app.get('/api/generate-status/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const weekStart = req.query.weekStart;
  if (!weekStart) return res.status(400).json({ error: 'weekStart query param required' });

  const key = getGenKey(userId, weekStart);
  const status = genStatus.get(key);

  // Build per-day status array
  const days = [];
  let completed = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const plan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);

    // Check if this day had an error in the current generation
    const dayError = status?.errors?.find(e => e.day === i);

    if (plan) {
      days.push({ date, index: i, status: 'done', calories: plan.total_calories || 0 });
      completed++;
    } else if (dayError) {
      days.push({ date, index: i, status: 'error', error: dayError.error });
      completed++; // errors count toward completed
    } else if (status && status.status === 'generating') {
      days.push({ date, index: i, status: 'generating' });
    } else {
      days.push({ date, index: i, status: 'pending' });
    }
  }

  if (!status) {
    return res.json({
      status: completed === 7 ? 'complete' : 'none',
      completed, total: 7, errors: [], days
    });
  }

  // Use computed per-day completed count (more accurate than status.completed which counts errors)
  const response = {
    status: status.status,
    completed: completed,
    total: status.total,
    errors: status.errors,
    days
  };
  res.json(response);
});

// ── API: Generate week (parallel, SSE) — legacy, resilient to disconnect ──
app.post('/api/generate-week', async (req, res) => {
  const { userId, weekStart } = req.body;
  if (!userId || !weekStart) return res.status(400).json({ error: 'userId and weekStart required' });

  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientConnected = true;
  req.on('close', () => { clientConnected = false; });

  function safeWrite(data) {
    if (!clientConnected) return;
    try { res.write(data); } catch (e) { clientConnected = false; }
  }

  safeWrite(`data: ${JSON.stringify({ type: 'start', total: 7 })}\n\n`);

  // Build array of 7 dates
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(weekStart, i));
  }

  // Get previous meal names for anti-repetition
  const prevMealNames = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(weekStart, -i);
    const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
    if (prevPlan) {
      prevMealNames.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
    }
  }

  // Fire all 7 in parallel
  const promises = dates.map((date, idx) => {
    const dayIdx = getDayIndex(date);
    const dayName = DAY_NAMES_CS[dayIdx];

    return generateDayPlan(user, date, prevMealNames)
      .then(dayPlan => {
        const mealsJson = JSON.stringify(dayPlan.meals);

        // Upsert into DB
        const existing = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);
        let planId;
        if (existing) {
          runDb(
            `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
            [dayPlan.day || dayName,
             dayPlan.total_calories || 0,
             dayPlan.total_protein || 0,
             dayPlan.total_carbs || 0,
             dayPlan.total_fat || 0,
             mealsJson,
             existing.id]
          );
          planId = existing.id;
        } else {
          planId = runDb(
            `INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, date, dayPlan.day || dayName,
             dayPlan.total_calories || 0, dayPlan.total_protein || 0,
             dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson]
          );
        }

        const plan = planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]));
        safeWrite(`data: ${JSON.stringify({ type: 'day_done', day: idx, name: dayName, date, plan })}\n\n`);
        console.log(`[AI] Week day ${idx + 1}/7 done: ${dayName} ${dayPlan.total_calories} kcal`);
        return plan;
      })
      .catch(err => {
        console.error(`[AI] Week day ${idx + 1}/7 failed: ${err.message}`);
        safeWrite(`data: ${JSON.stringify({ type: 'day_error', day: idx, name: dayName, date, error: err.message })}\n\n`);
        return null;
      });
  });

  try {
    const results = await Promise.all(promises);
    const succeeded = results.filter(Boolean);
    safeWrite(`data: ${JSON.stringify({ type: 'complete', total: succeeded.length })}\n\n`);
  } catch (err) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  if (clientConnected) res.end();
});

// ── API: Chat ────────────────────────────────────────────────────────
app.get('/api/chat/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rows = queryAll('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]);
  res.json(rows.reverse());
});

app.post('/api/chat', async (req, res) => {
  const { userId, message, planDate } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Save user message
  runDb('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)', [userId, 'user', message]);

  // Get recent history
  const history = queryAll('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]).slice(0, 20).reverse();

  // Get current plan if planDate provided
  let planContext = '';
  if (planDate) {
    const plan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, planDate]);
    if (plan) {
      planContext = `\nAktuální plán pro ${planDate}:\n${plan.meals_json}`;
    }
  }

  const systemMsg = `Jsi výživový poradce pro ${user.name}. Cíl: ${user.calories_target || 2000}kcal. Diety: ${user.dietary_restrictions || 'žádné'}.
${planContext}
Odpovídej v češtině. Pokud uživatel žádá změnu jídelníčku, navrhni konkrétní změny.`;

  // SSE for chat streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    const stream = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemMsg },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ],
      temperature: 0.7,
      max_tokens: 2000,
      stream: true,
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        res.write(`data: ${JSON.stringify({ type: 'token', content: delta })}\n\n`);
      }
    }

    // Save assistant message
    runDb('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)', [userId, 'assistant', fullContent]);
    res.write(`data: ${JSON.stringify({ type: 'done', message: fullContent })}\n\n`);
    res.end();
  } catch (err) {
    console.error(`[AI] Chat error: ${err.message}`);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

// ── API: Shopping List ───────────────────────────────────────────────
app.get('/api/shopping-list/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params required' });

  // Check cached
  const cached = queryOne('SELECT * FROM shopping_lists WHERE user_id = ? AND date_from = ? AND date_to = ?', [userId, from, to]);
  if (cached) return res.json({ items: JSON.parse(cached.items_json), from, to });

  // Get plans in range
  const plans = queryAll('SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, from, to]);
  if (!plans.length) return res.json({ items: [], from, to });

  const parseIng = (s) => {
    const raw = s.trim();
    let m = raw.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?$/i);
    if (m) return { name: m[1].trim(), qty: parseFloat(m[2].replace(',', '.')), unit: normUnit(m[3] || 'ks') };
    m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?\s+(.+)$/i);
    if (m) return { name: m[3].trim(), qty: parseFloat(m[1].replace(',', '.')), unit: normUnit(m[2] || 'ks') };
    return { name: raw, qty: 0, unit: '' };
  };

  const normUnit = (u) => {
    const l = (u || 'ks').toLowerCase();
    if (['lžíce', 'lžičky', 'lžička', 'lžiček', 'polévková lžíce'].includes(l)) return 'lžíce';
    if (['stroužek', 'stroužky'].includes(l)) return 'stroužky';
    return l;
  };

  const categorize = (name) => {
    const n = name.toLowerCase();
    const cats = [
      [/maso|kuře|krůt|vepřov|hověz|losos|tuňák|candát|treska|slanina|šunka|mleté/, '🥩 Maso a ryby'],
      [/sýr|eidam|parmaz|cottage|lučina|tvaroh|mozzarell/, '🧀 Sýry'],
      [/jogurt|mléko|smetana|kefír/, '🥛 Mléčné'],
      [/vejce/, '🥚 Vejce'],
      [/chléb|chleb|toast|knäckebrot|tortilla|polenta/, '🍞 Pečivo'],
      [/rýže|těstovin|kuskus|quinoa|pohanka|vločky|mouka|knedlík/, '🌾 Obiloviny'],
      [/banán|jablk|jahod|borůvk|malin|hrozn|ovoc|citrus|citrón|pomeranč/, '🍎 Ovoce'],
      [/okurk|rajč|paprik|brokolic|špenát|cuket|salát|ředkvič|mrkev|cibul|oliv|zelí|luštěnin|fazol|hrášek|zelenin|avokád/, '🥬 Zelenina'],
      [/protein|whey|srvát/, '💪 Protein'],
      [/olej|máslo|med|sirup|arašídové máslo/, '🧈 Tuky a sladidla'],
      [/omáčka|protlak|dresink|sójo|ocet|kření|koření|bylink|sůl|pepř/, '🧂 Koření a omáčky'],
      [/tyčink|pudink/, '🍫 Sladkosti'],
    ];
    for (const [re, cat] of cats) { if (re.test(n)) return cat; }
    return '📦 Ostatní';
  };

  const baseName = (n) => n.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/\b(syrov[éý]|čerstv[éeý]|mražen[éeý]|grilovan[éeý]|vařen[éeý]|pečen[éeý]|celozrnn[éeý]|odtučněn[éeý]|polotučn[éeý]|libov[éeý]|hladké|na ozdobu|bez kůže|ve vlastní šťávě)\b/gi, '').replace(/\s+/g, ' ').trim();

  const merged = {};

  plans.forEach(planRow => {
    const dayMeals = JSON.parse(planRow.meals_json);
    Object.values(dayMeals).forEach(meal => {
      (meal.ingredients || []).forEach(raw => {
        const p = parseIng(raw);
        const bn = baseName(p.name);
        let bestKey = null, bestScore = 0;
        for (const existingKey of Object.keys(merged)) {
          const eb = baseName(existingKey);
          if (eb === bn) { bestKey = existingKey; bestScore = 1; break; }
          if (eb.length > 3 && bn.length > 3) {
            if (eb.includes(bn) || bn.includes(eb)) {
              const score = Math.min(eb.length, bn.length) / Math.max(eb.length, bn.length);
              if (score > bestScore && score > 0.5) { bestScore = score; bestKey = existingKey; }
            }
          }
        }
        if (bestKey && merged[bestKey].unit === p.unit) {
          merged[bestKey].qty += p.qty;
        } else if (bestKey && p.qty > 0) {
          if (!merged[bestKey].also) merged[bestKey].also = [];
          merged[bestKey].also.push(`${p.qty} ${p.unit}`);
        } else {
          merged[p.name.toLowerCase()] = { name: p.name, qty: p.qty, unit: p.unit, category: categorize(p.name), checked: false };
        }
      });
    });
  });

  const list = Object.values(merged).map(item => {
    let display = item.name;
    if (item.qty > 0) {
      const q = item.qty % 1 === 0 ? item.qty : item.qty.toFixed(1).replace('.0', '');
      display += ` ${q} ${item.unit}`;
    }
    if (item.also) display += ` + ${item.also.join(' + ')}`;
    return { ...item, display };
  }).sort((a, b) => a.category.localeCompare(b.category, 'cs') || a.name.localeCompare(b.name, 'cs'));

  // Cache
  runDb('INSERT INTO shopping_lists (user_id, date_from, date_to, items_json) VALUES (?, ?, ?, ?)', [userId, from, to, JSON.stringify(list)]);
  res.json({ items: list, from, to });
});

// ── API: Meal Detail (on-demand AI generation, cached) ──────────────
app.post('/api/meal-detail', async (req, res) => {
  const { planId, mealType, meal } = req.body;
  if (!planId || !mealType || !meal) return res.status(400).json({ error: 'planId, mealType, and meal required' });

  // Check cache first
  const cached = queryOne('SELECT * FROM meal_details WHERE plan_id = ? AND meal_type = ?', [planId, mealType]);
  if (cached) {
    return res.json({
      recipe: JSON.parse(cached.recipe_json),
      cookware: JSON.parse(cached.cookware_json),
      why: cached.why_text,
      cached: true,
    });
  }

  // Verify plan exists
  const plan = queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Get user for context
  const user = queryOne('SELECT * FROM users WHERE id = ?', [plan.user_id]);

  const prompt = `Jsi výživový poradce a kuchař. Pro následující jídlo vytvoř detailní informace.

Jídlo: ${meal.name}
Suroviny: ${(meal.ingredients || []).join(', ')}
Kalorie: ${meal.calories || '?'} kcal | Bílkoviny: ${meal.protein || '?'}g | Sacharidy: ${meal.carbs || '?'}g | Tuky: ${meal.fat || '?'}g
Doba přípravy: ${meal.prep_time || '?'}
${user ? `Uživatel: ${user.name}, cíl ${user.calories_target || 2000} kcal, dieta: ${user.dietary_restrictions || 'žádné'}, alergie: ${user.allergies || 'žádné'}` : ''}

Vrať POUZE JSON s tímto přesným formátem (žádný jiný text):
{"recipe":["Krok 1: ...","Krok 2: ...","Krok 3: ..."],"cookware":["Pánev","Hrnek","..."],"why":"Stručné vysvětlení (2-3 věty) proč je toto jídlo vhodné z nutričního hlediska s ohledem na makroživiny a cíl uživatele."}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const completion = await ai.chat.completions.create(
      {
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'Output directly. No reasoning. No thinking. Just respond with the JSON immediately.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      },
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    const raw = (completion.choices[0].message.content || '').trim();
    if (!raw) throw new Error('AI returned empty content');

    // Parse the AI response
    let detail;
    try {
      let content = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const jsonStart = content.indexOf('{');
      if (jsonStart > 0) content = content.substring(jsonStart);
      detail = JSON.parse(content);
    } catch (parseErr) {
      console.error(`[AI] meal-detail parse error: ${parseErr.message}, raw: ${raw.substring(0, 200)}`);
      throw new Error('Failed to parse AI response');
    }

    const recipe = Array.isArray(detail.recipe) ? detail.recipe : [];
    const cookware = Array.isArray(detail.cookware) ? detail.cookware : [];
    const why = detail.why || '';

    // Cache in DB
    runDb(
      'INSERT OR REPLACE INTO meal_details (plan_id, meal_type, recipe_json, cookware_json, why_text) VALUES (?, ?, ?, ?, ?)',
      [planId, mealType, JSON.stringify(recipe), JSON.stringify(cookware), why]
    );

    res.json({ recipe, cookware, why, cached: false });
  } catch (err) {
    console.error(`[AI] meal-detail error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA Fallback ─────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function main() {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Jídelníček v3 running on :${PORT} (SQLite/sql.js WASM, day-by-day, parallel week)`);
  });
}

main().catch(err => { console.error('Startup failed:', err); process.exit(1); });

process.on('uncaughtException', err => console.error('Uncaught:', err.message));
