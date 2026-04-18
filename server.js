// ═══════════════════════════════════════════════════════════════════════
// Jídelníček v3 — Day-by-day generation, SQLite, SSE
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database (SQLite) ────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'jidelnicek.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
  );

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
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shopping_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, date_from, date_to)
  );
`);

// ── Prepared statements ──────────────────────────────────────────────
const stmt = {
  // Users
  getUsers: db.prepare('SELECT * FROM users ORDER BY id'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser: db.prepare(`INSERT INTO users (name, sex, age, weight_current, weight_goal, height, activity_level, dietary_restrictions, allergies, favorite_foods, calories_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateUser: db.prepare(`UPDATE users SET name=?, sex=?, age=?, weight_current=?, weight_goal=?, height=?, activity_level=?, dietary_restrictions=?, allergies=?, favorite_foods=?, calories_target=? WHERE id=?`),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  // Meal plans
  getPlanById: db.prepare('SELECT * FROM meal_plans WHERE id = ?'),
  getPlanByUserDate: db.prepare('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?'),
  getPlansByUserRange: db.prepare('SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'),
  getAllPlansByUser: db.prepare('SELECT * FROM meal_plans WHERE user_id = ? ORDER BY date DESC'),
  insertPlan: db.prepare(`INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  updatePlan: db.prepare(`UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`),
  deletePlan: db.prepare('DELETE FROM meal_plans WHERE id = ?'),
  deletePlansByUserRange: db.prepare('DELETE FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ?'),

  // Chat
  getChatByUser: db.prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100'),
  insertChat: db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)'),

  // Shopping
  getShoppingList: db.prepare('SELECT * FROM shopping_lists WHERE user_id = ? AND date_from = ? AND date_to = ?'),
  insertShoppingList: db.prepare('INSERT INTO shopping_lists (user_id, date_from, date_to, items_json) VALUES (?, ?, ?, ?)'),
  updateShoppingList: db.prepare('UPDATE shopping_lists SET items_json=? WHERE id=?'),
};

// ── AI Client ────────────────────────────────────────────────────────
const AI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const AI_MODEL = 'GLM-4.5-Air';
const ai = new OpenAI({ apiKey: process.env.ZAI_API_KEY, baseURL: AI_BASE_URL });
console.log(`[AI] model=${AI_MODEL} baseURL=${AI_BASE_URL}`);

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

  const prompt = `Jsi profesionální výživový poradce. Vytvoř JEDEN den (${dayName}) jídelníčku v JSON.

Uživatel: ${user.name}, ${user.sex === 'male' ? 'muž' : user.sex === 'female' ? 'žena' : '?'}, ${user.age || '?'} let, ${user.weight_current || '?'}kg → ${user.weight_goal || '?'}kg
Aktivita: ${user.activity_level || 'moderate'}, diety: ${user.dietary_restrictions || 'žádné'}
Alergie: ${user.allergies || 'žádné'}, oblíbená jídla: ${user.favorite_foods || 'neuvedeno'}
Cíl: ${targetCal} kcal/den, max 30min příprava na jedno jídlo.${antiRepeat}

Vrať POUZE valid JSON bez markdown:
{"day":"${dayName}","total_calories":N,"total_protein":N,"total_carbs":N,"total_fat":N,"meals":{"breakfast":{"name":"...","calories":N,"protein":N,"carbs":N,"fat":N,"ingredients":["položka s množstvím"],"prep_time":"N min"},"morning_snack":{...},"lunch":{...},"afternoon_snack":{...},"dinner":{...}}}

Pravidla:
- Pouze české suroviny dostupné v českých supermarketech
- Makro split: 30% bílkoviny / 40% sacharidy / 30% tuky
- Rozložení kalorií: snídaně~22%, dopolední svačina~8%, oběd~30%, odpolední svačina~8%, večeře~32%
- Každé jídlo musí mít realistický název, ingredience s množstvím a čas přípravy
- Vrať POUZE JSON, žádný text navíc`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const completion = await ai.chat.completions.create(
      { model: AI_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: 3000 },
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    const raw = (completion.choices[0].message.content || '').trim();
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
  res.json({ status: 'ok', version: '3.0.0', model: AI_MODEL, db: 'sqlite' });
});

// ── API: Users ───────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(stmt.getUsers.all());
});

app.post('/api/users', (req, res) => {
  const d = req.body;
  if (!d.name) return res.status(400).json({ error: 'Name is required' });

  // Calculate calories target
  const tempUser = { ...d, activity_level: d.activity_level || 'moderate' };
  const calories_target = calcCaloriesTarget(tempUser);

  const info = stmt.createUser.run(
    d.name, d.sex || null, d.age || null,
    d.weight_current || null, d.weight_goal || null, d.height || null,
    d.activity_level || 'moderate', d.dietary_restrictions || '',
    d.allergies || '', d.favorite_foods || '', calories_target
  );
  const user = stmt.getUserById.get(info.lastInsertRowid);
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const d = req.body;
  const id = parseInt(req.params.id);
  const tempUser = { ...d, activity_level: d.activity_level || 'moderate' };
  const calories_target = calcCaloriesTarget(tempUser);

  stmt.updateUser.run(
    d.name, d.sex || null, d.age || null,
    d.weight_current || null, d.weight_goal || null, d.height || null,
    d.activity_level || 'moderate', d.dietary_restrictions || '',
    d.allergies || '', d.favorite_foods || '', calories_target, id
  );
  const user = stmt.getUserById.get(id);
  user ? res.json(user) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/users/:id', (req, res) => {
  stmt.deleteUser.run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── API: Get plans ───────────────────────────────────────────────────
app.get('/api/plan/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const from = req.query.from;
  const to = req.query.to;

  if (from && to) {
    const rows = stmt.getPlansByUserRange.all(userId, from, to);
    return res.json(rows.map(planToJSON));
  }

  // Return all plans for user
  const rows = stmt.getAllPlansByUser.all(userId);
  res.json(rows.map(planToJSON));
});

// ── API: Edit a meal plan ────────────────────────────────────────────
app.put('/api/plan/:planId', (req, res) => {
  const planId = parseInt(req.params.planId);
  const d = req.body;
  const existing = stmt.getPlanById.get(planId);
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

  stmt.updatePlan.run(
    d.day_name || existing.day_name,
    d.total_calories || totalCal,
    d.total_protein || totalP,
    d.total_carbs || totalC,
    d.total_fat || totalF,
    JSON.stringify(meals),
    planId
  );
  res.json(planToJSON(stmt.getPlanById.get(planId)));
});

// ── API: Delete a plan ───────────────────────────────────────────────
app.delete('/api/plan/:planId', (req, res) => {
  stmt.deletePlan.run(parseInt(req.params.planId));
  res.json({ ok: true });
});

// ── API: Generate single day ─────────────────────────────────────────
app.post('/api/generate-day', async (req, res) => {
  const { userId, date } = req.body;
  if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });

  const user = stmt.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get previous 3-4 days of meal names for anti-repetition
  const prevDays = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(date, -i);
    const prevPlan = stmt.getPlanByUserDate.get(userId, prevDate);
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
    const existing = stmt.getPlanByUserDate.get(userId, date);
    if (existing) {
      stmt.updatePlan.run(
        dayPlan.day || dayName,
        dayPlan.total_calories || 0,
        dayPlan.total_protein || 0,
        dayPlan.total_carbs || 0,
        dayPlan.total_fat || 0,
        mealsJson,
        existing.id
      );
      return res.json(planToJSON(stmt.getPlanById.get(existing.id)));
    } else {
      const info = stmt.insertPlan.run(
        userId, date, dayPlan.day || dayName,
        dayPlan.total_calories || 0, dayPlan.total_protein || 0,
        dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson
      );
      return res.json(planToJSON(stmt.getPlanById.get(info.lastInsertRowid)));
    }
  } catch (err) {
    console.error(`[AI] generate-day error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ── API: Generate week (parallel, SSE) ───────────────────────────────
app.post('/api/generate-week', async (req, res) => {
  const { userId, weekStart } = req.body;
  if (!userId || !weekStart) return res.status(400).json({ error: 'userId and weekStart required' });

  const user = stmt.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'start', total: 7 })}\n\n`);

  // Build array of 7 dates
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(weekStart, i));
  }

  // Get previous meal names for anti-repetition
  const prevMealNames = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(weekStart, -i);
    const prevPlan = stmt.getPlanByUserDate.get(userId, prevDate);
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
        const existing = stmt.getPlanByUserDate.get(userId, date);
        let planId;
        if (existing) {
          stmt.updatePlan.run(
            dayPlan.day || dayName,
            dayPlan.total_calories || 0,
            dayPlan.total_protein || 0,
            dayPlan.total_carbs || 0,
            dayPlan.total_fat || 0,
            mealsJson,
            existing.id
          );
          planId = existing.id;
        } else {
          const info = stmt.insertPlan.run(
            userId, date, dayPlan.day || dayName,
            dayPlan.total_calories || 0, dayPlan.total_protein || 0,
            dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson
          );
          planId = info.lastInsertRowid;
        }

        const plan = planToJSON(stmt.getPlanById.get(planId));
        res.write(`data: ${JSON.stringify({ type: 'day_done', day: idx, name: dayName, date, plan })}\n\n`);
        console.log(`[AI] Week day ${idx + 1}/7 done: ${dayName} ${dayPlan.total_calories} kcal`);
        return plan;
      })
      .catch(err => {
        console.error(`[AI] Week day ${idx + 1}/7 failed: ${err.message}`);
        res.write(`data: ${JSON.stringify({ type: 'day_error', day: idx, name: dayName, date, error: err.message })}\n\n`);
        return null;
      });
  });

  try {
    const results = await Promise.all(promises);
    const succeeded = results.filter(Boolean);
    res.write(`data: ${JSON.stringify({ type: 'complete', total: succeeded.length })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
});

// ── API: Chat ────────────────────────────────────────────────────────
app.get('/api/chat/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rows = stmt.getChatByUser.all(userId);
  res.json(rows.reverse());
});

app.post('/api/chat', async (req, res) => {
  const { userId, message, planDate } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });

  const user = stmt.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Save user message
  stmt.insertChat.run(userId, 'user', message);

  // Get recent history
  const history = stmt.getChatByUser.all(userId).slice(0, 20).reverse();

  // Get current plan if planDate provided
  let planContext = '';
  if (planDate) {
    const plan = stmt.getPlanByUserDate.get(userId, planDate);
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
    stmt.insertChat.run(userId, 'assistant', fullContent);
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
  const cached = stmt.getShoppingList.get(userId, from, to);
  if (cached) return res.json({ items: JSON.parse(cached.items_json), from, to });

  // Get plans in range
  const plans = stmt.getPlansByUserRange.all(userId, from, to);
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
  stmt.insertShoppingList.run(userId, from, to, JSON.stringify(list));
  res.json({ items: list, from, to });
});

// ── SPA Fallback ─────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Jídelníček v3 running on :${PORT} (SQLite, day-by-day, parallel week)`);
});

process.on('uncaughtException', err => console.error('Uncaught:', err.message));
