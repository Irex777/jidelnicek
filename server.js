const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!require('fs').existsSync(dataDir)) require('fs').mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'jidelnicek.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    locale TEXT DEFAULT 'cs',
    weight_current REAL,
    weight_goal REAL,
    height REAL,
    age INTEGER,
    sex TEXT,
    activity_level TEXT DEFAULT 'moderate',
    dietary_restrictions TEXT DEFAULT '',
    calories_target INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meal_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    meals JSON NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, week_start),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shopping_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    items JSON NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── AI Client ─────────────────────────────────────────────────────────
const ai = new OpenAI({
  apiKey: process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY || '',
  baseURL: process.env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
});

const AI_MODEL = process.env.AI_MODEL || 'glm-4-flash';

// ── Localization ──────────────────────────────────────────────────────
const LOCALES = {
  cs: {
    dayNames: ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'],
    mealTypes: { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' },
    units: { g: 'g', ml: 'ml', ks: 'ks', lžíce: 'lžíce', špetka: 'špetka', svazek: 'svazek' },
    prepTitle: 'Příprava',
    shopTitle: 'Nákupní seznam',
    weekTitle: 'Jídelníček pro týden',
    calories: 'kcal',
    protein: 'Bílkoviny',
    carbs: 'Sacharidy',
    fat: 'Tuky',
    fiber: 'Vláknina',
    total: 'Celkem',
    generateBtn: 'Generovat týden',
    chatPlaceholder: 'Zeptej se AI na změny jídelníčku...',
    sendBtn: 'Odeslat',
    profileBtn: 'Profil',
    shopBtn: 'Nákupní seznam',
    prepBtn: 'Příprava',
    saveBtn: 'Uložit',
    newUser: 'Nový uživatel',
    selectUser: 'Vyberte uživatele',
    weightGoal: 'Cíl váhy',
    currentWeight: 'Aktuální váha',
    restrictions: 'Diety/restrikce',
    height: 'Výška',
    age: 'Věk',
    sex: 'Pohlaví',
    activity: 'Aktivita',
    male: 'Muž',
    female: 'Žena',
    sedentary: 'Sedavý',
    light: 'Lehká',
    moderate: 'Střední',
    active: 'Aktivní',
    veryActive: 'Velmi aktivní',
    deletePlan: 'Smazat plán',
    cloneWeek: 'Kopírovat na další týden',
  },
  en: {
    dayNames: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    mealTypes: { breakfast: 'Breakfast', morning_snack: 'Morning snack', lunch: 'Lunch', afternoon_snack: 'Afternoon snack', dinner: 'Dinner' },
    units: { g: 'g', ml: 'ml', ks: 'pcs', lžíce: 'tbsp', špetka: 'pinch', svazek: 'bunch' },
    prepTitle: 'Prep Guide',
    shopTitle: 'Shopping List',
    weekTitle: 'Meal plan for week',
    calories: 'kcal',
    protein: 'Protein',
    carbs: 'Carbs',
    fat: 'Fat',
    fiber: 'Fiber',
    total: 'Total',
    generateBtn: 'Generate Week',
    chatPlaceholder: 'Ask AI to modify your meal plan...',
    sendBtn: 'Send',
    profileBtn: 'Profile',
    shopBtn: 'Shopping List',
    prepBtn: 'Prep',
    saveBtn: 'Save',
    newUser: 'New User',
    selectUser: 'Select user',
    weightGoal: 'Weight Goal',
    currentWeight: 'Current Weight',
    restrictions: 'Dietary restrictions',
    height: 'Height',
    age: 'Age',
    sex: 'Sex',
    activity: 'Activity',
    male: 'Male',
    female: 'Female',
    sedentary: 'Sedentary',
    light: 'Light',
    moderate: 'Moderate',
    active: 'Active',
    veryActive: 'Very Active',
    deletePlan: 'Delete Plan',
    cloneWeek: 'Copy to next week',
  },
};

function getLocale(lang) {
  return LOCALES[lang] || LOCALES.cs;
}

// ── Helpers ───────────────────────────────────────────────────────────
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function calcBMR(user) {
  if (!user.weight_current || !user.height || !user.age || !user.sex) return 2000;
  if (user.sex === 'male') {
    return Math.round(10 * user.weight_current + 6.25 * user.height - 5 * user.age + 5);
  }
  return Math.round(10 * user.weight_current + 6.25 * user.height - 5 * user.age - 161);
}

function calcTDEE(bmr, level) {
  const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  return Math.round(bmr * (mult[level] || 1.55));
}

// ── API: Users ────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { name, locale, weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions } = req.body;
  const bmr = calcBMR({ weight_current, height, age, sex });
  const tdee = calcTDEE(bmr, activity_level);
  // For weight loss, subtract 500 kcal
  const calories_target = weight_goal && weight_current && weight_goal < weight_current ? tdee - 500 : tdee;
  const r = db.prepare(`INSERT INTO users (name, locale, weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions, calories_target)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, locale || 'cs', weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions, calories_target);
  res.json({ id: r.lastInsertRowid, calories_target });
});

app.put('/api/users/:id', (req, res) => {
  const { name, locale, weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions } = req.body;
  const bmr = calcBMR({ weight_current, height, age, sex });
  const tdee = calcTDEE(bmr, activity_level);
  const calories_target = weight_goal && weight_current && weight_goal < weight_current ? tdee - 500 : tdee;
  db.prepare(`UPDATE users SET name=?, locale=?, weight_current=?, weight_goal=?, height=?, age=?, sex=?, activity_level=?, dietary_restrictions=?, calories_target=? WHERE id=?`)
    .run(name, locale, weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions, calories_target, req.params.id);
  res.json({ ok: true, calories_target });
});

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM shopping_lists WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM meal_plans WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── API: Meal Plans ──────────────────────────────────────────────────
app.get('/api/plans/:userId/:weekStart', (req, res) => {
  const plan = db.prepare('SELECT * FROM meal_plans WHERE user_id=? AND week_start=?').get(req.params.userId, req.params.weekStart);
  if (plan) plan.meals = JSON.parse(plan.meals);
  res.json(plan || null);
});

app.post('/api/plans', (req, res) => {
  const { user_id, week_start, meals } = req.body;
  db.prepare(`INSERT INTO meal_plans (user_id, week_start, meals) VALUES (?, ?, ?)
    ON CONFLICT(user_id, week_start) DO UPDATE SET meals=excluded.meals, updated_at=CURRENT_TIMESTAMP`)
    .run(user_id, week_start, JSON.stringify(meals));
  res.json({ ok: true });
});

app.delete('/api/plans/:userId/:weekStart', (req, res) => {
  db.prepare('DELETE FROM meal_plans WHERE user_id=? AND week_start=?').run(req.params.userId, req.params.weekStart);
  db.prepare('DELETE FROM shopping_lists WHERE user_id=? AND week_start=?').run(req.params.userId, req.params.weekStart);
  res.json({ ok: true });
});

// ── API: Generate with AI ─────────────────────────────────────────────
app.post('/api/generate/:userId', async (req, res) => {
  const { week_start } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const loc = getLocale(user.locale);
  const days = loc.dayNames;
  const mealTypes = Object.keys(loc.mealTypes);
  const targetCal = user.calories_target || 2000;

  const prompt = `Jsi profesionální výživový poradce. Vytvoř týdenní jídelníček v JSON formátu.

Uživatel: ${user.name}
Aktuální váha: ${user.weight_current || '?'} kg
Cílová váha: ${user.weight_goal || '?'} kg
Výška: ${user.height || '?'} cm
Věk: ${user.age || '?'}
Pohlaví: ${user.sex === 'male' ? 'muž' : user.sex === 'female' ? 'žena' : '?'}
Aktivita: ${user.activity_level || 'moderate'}
Diety/restrikce: ${user.dietary_restrictions || 'žádné'}
Denní cíl kalorií: ${targetCal} kcal

Vrať POUZE valid JSON, žádný markdown, žádné komentáře. Struktura:
{
  "days": [
    {
      "day": "${days[0]}",
      "total_calories": number,
      "total_protein": number,
      "total_carbs": number,
      "total_fat": number,
      "meals": {
        "breakfast": { "name": "...", "calories": N, "protein": N, "carbs": N, "fat": N, "ingredients": ["položka s množstvím"], "prep": "stručný postup" },
        "morning_snack": { ... },
        "lunch": { ... },
        "afternoon_snack": { ... },
        "dinner": { ... }
      }
    }
    ... 7 days total
  ]
}

Pravidla:
- Reálné české suroviny dostupné v obchodech (Kaufland, Albert, Lidl, Tesco)
- Vyvážené makroživiny (30% bílkoviny, 40% sacharidy, 30% tuky)
- Denní součet kalorií ~${targetCal} kcal (pro hubnutí o 500 méně než TDEE)
- Rozmanité jídlo, neopakovat stejné recepty
- U surovin uvádějte přesné množství (g, ml, ks)
- Jídla musí být snadná na přípravu (max 30 min)
- Uveďte krátký postup přípravy u každého jídla`;

  try {
    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 8000,
    });

    let content = completion.choices[0].message.content.trim();
    // Strip markdown code fences if present
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const plan = JSON.parse(content);

    // Restructure to our storage format
    const meals = {};
    plan.days.forEach((day, i) => {
      meals[i] = {
        day: day.day,
        total_calories: day.total_calories,
        total_protein: day.total_protein,
        total_carbs: day.total_carbs,
        total_fat: day.total_fat,
        meals: day.meals,
      };
    });

    db.prepare(`INSERT INTO meal_plans (user_id, week_start, meals) VALUES (?, ?, ?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET meals=excluded.meals, updated_at=CURRENT_TIMESTAMP`)
      .run(user.id, week_start, JSON.stringify(meals));

    // Save AI message to chat history
    db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
      .run(user.id, 'assistant', `Vygeneroval jsem jídelníček pro týden ${week_start}. Celkem ~${targetCal} kcal/den. Chceš něco změnit?`);

    res.json({ meals });
  } catch (err) {
    console.error('AI generation error:', err);
    res.status(500).json({ error: 'Failed to generate meal plan', details: err.message });
  }
});

// ── API: Chat with AI ─────────────────────────────────────────────────
app.get('/api/chat/:userId', (req, res) => {
  const msgs = db.prepare('SELECT * FROM chat_messages WHERE user_id=? ORDER BY created_at ASC LIMIT 100').all(req.params.userId);
  res.json(msgs);
});

app.post('/api/chat/:userId', async (req, res) => {
  const { message, week_start } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Save user message
  db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
    .run(user.id, 'user', message);

  // Load current plan
  let currentPlan = null;
  if (week_start) {
    const row = db.prepare('SELECT meals FROM meal_plans WHERE user_id=? AND week_start=?').get(user.id, week_start);
    if (row) currentPlan = JSON.parse(row.meals);
  }

  // Build conversation history
  const history = db.prepare('SELECT role, content FROM chat_messages WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id).reverse();

  const systemMsg = `Jsi profesionální výživový poradce a kuchař. Pomáháš uživateli ${user.name} s jídelníčkem.
Denní kalorický cíl: ${user.calories_target || 2000} kcal.
Diety: ${user.dietary_restrictions || 'žádné'}.
${currentPlan ? `Aktuální jídelníček (JSON):\n${JSON.stringify(currentPlan, null, 2)}` : 'Zatím nebyl vytvořen žádný plán.'}

Pokud uživatel žádá změnu jídelníčku, vrať POUZE JSON s celým aktualizovaným plánem ve formátu:
{"meals": { "0": { "day": "...", "total_calories": N, "total_protein": N, "total_carbs": N, "total_fat": N, "meals": { "breakfast": {...}, ... } }, ... }}

Pokud jen odpovídáš na otázku, vrať normální text bez JSON.`;

  const apiMessages = [
    { role: 'system', content: systemMsg },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    const completion = await ai.chat.completions.create({
      model: AI_MODEL,
      messages: apiMessages,
      temperature: 0.7,
      max_tokens: 8000,
    });

    let content = completion.choices[0].message.content.trim();

    // Check if response contains updated plan
    let updatedPlan = null;
    const jsonMatch = content.match(/\{[\s\S]*"meals"\s*:\s*\{/);
    if (jsonMatch) {
      try {
        // Try to extract JSON from the response
        let jsonStr = content;
        // Remove text before JSON
        const startIdx = content.indexOf('{"meals"');
        if (startIdx >= 0) {
          jsonStr = content.substring(startIdx);
          // Find the matching closing brace
          let depth = 0;
          let endIdx = 0;
          for (let i = 0; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') depth++;
            if (jsonStr[i] === '}') depth--;
            if (depth === 0) { endIdx = i + 1; break; }
          }
          jsonStr = jsonStr.substring(0, endIdx);
        }
        const parsed = JSON.parse(jsonStr);
        if (parsed.meals) {
          updatedPlan = parsed.meals;
          // Save updated plan
          db.prepare(`INSERT INTO meal_plans (user_id, week_start, meals) VALUES (?, ?, ?)
            ON CONFLICT(user_id, week_start) DO UPDATE SET meals=excluded.meals, updated_at=CURRENT_TIMESTAMP`)
            .run(user.id, week_start, JSON.stringify(updatedPlan));
          // Clean the text response - remove JSON part
          content = content.substring(0, content.indexOf('{"meals"')).trim() || 'Jídelníček byl aktualizován!';
        }
      } catch (e) {
        // Not valid JSON, just treat as text response
      }
    }

    db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
      .run(user.id, 'assistant', content);

    res.json({ message: content, updatedPlan });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI request failed', details: err.message });
  }
});

// ── API: Shopping List ────────────────────────────────────────────────
app.get('/api/shopping/:userId/:weekStart', (req, res) => {
  const row = db.prepare('SELECT items FROM shopping_lists WHERE user_id=? AND week_start=?').get(req.params.userId, req.params.weekStart);
  if (row) return res.json(JSON.parse(row.items));

  // Auto-generate from meal plan
  const plan = db.prepare('SELECT meals FROM meal_plans WHERE user_id=? AND week_start=?').get(req.params.userId, req.params.weekStart);
  if (!plan) return res.json([]);

  const meals = JSON.parse(plan.meals);
  const items = {};

  Object.values(meals).forEach(day => {
    Object.values(day.meals || {}).forEach(meal => {
      (meal.ingredients || []).forEach(ing => {
        const key = ing.toLowerCase().trim();
        if (!items[key]) items[key] = { name: ing, checked: false };
      });
    });
  });

  const list = Object.values(items).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  db.prepare('INSERT OR REPLACE INTO shopping_lists (user_id, week_start, items) VALUES (?, ?, ?)')
    .run(parseInt(req.params.userId), req.params.weekStart, JSON.stringify(list));
  res.json(list);
});

app.put('/api/shopping/:userId/:weekStart', (req, res) => {
  db.prepare('INSERT OR REPLACE INTO shopping_lists (user_id, week_start, items) VALUES (?, ?, ?)')
    .run(parseInt(req.params.userId), req.params.weekStart, JSON.stringify(req.body.items));
  res.json({ ok: true });
});

// ── API: Prep Guide ───────────────────────────────────────────────────
app.get('/api/prep/:userId/:weekStart', (req, res) => {
  const plan = db.prepare('SELECT meals FROM meal_plans WHERE user_id=? AND week_start=?').get(req.params.userId, req.params.weekStart);
  if (!plan) return res.json({ days: [] });

  const meals = JSON.parse(plan.meals);
  const prep = { days: [] };

  Object.values(meals).forEach(day => {
    const dayPrep = { day: day.day, meals: [] };
    Object.entries(day.meals || {}).forEach(([type, meal]) => {
      dayPrep.meals.push({ type, name: meal.name, prep: meal.prep, ingredients: meal.ingredients });
    });
    prep.days.push(dayPrep);
  });

  res.json(prep);
});

// ── Spa fallback ──────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jídelníček running on :${PORT}`));
