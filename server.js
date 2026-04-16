const express = require('express');
const path = require('path');
const fs = require('fs');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFile = path.join(dataDir, 'db.json');
const defaultData = { users: [], meal_plans: [], chat_messages: [], shopping_lists: [] };
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2));

const adapter = new JSONFile(dbFile);
const db = new Low(adapter, defaultData);

async function initDb() {
  await db.read();
  db.data ||= defaultData;
  // Ensure arrays
  for (const key of Object.keys(defaultData)) {
    if (!Array.isArray(db.data[key])) db.data[key] = [];
  }
  await db.write();
}

// ── AI Client ─────────────────────────────────────────────────────────
const ai = new OpenAI({
  apiKey: process.env.ZAI_API_KEY || '',
  baseURL: process.env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
});

const AI_MODEL = process.env.AI_MODEL || 'glm-4-flash';

// ── Localization ──────────────────────────────────────────────────────
const LOCALES = {
  cs: {
    dayNames: ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'],
    mealTypes: { breakfast: 'Snídaně', morning_snack: 'Dop. svačina', lunch: 'Oběd', afternoon_snack: 'Odp. svačina', dinner: 'Večeře' },
  },
  en: {
    dayNames: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    mealTypes: { breakfast: 'Breakfast', morning_snack: 'Morning snack', lunch: 'Lunch', afternoon_snack: 'Afternoon snack', dinner: 'Dinner' },
  },
};

function getLocale(lang) { return LOCALES[lang] || LOCALES.cs; }

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
  if (user.sex === 'male') return Math.round(10 * user.weight_current + 6.25 * user.height - 5 * user.age + 5);
  return Math.round(10 * user.weight_current + 6.25 * user.height - 5 * user.age - 161);
}

function calcTDEE(bmr, level) {
  const mult = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  return Math.round(bmr * (mult[level] || 1.55));
}

let nextId = 1;
function genId() { return nextId++; }

// ── API: Users ────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  res.json(db.data.users);
});

app.post('/api/users', (req, res) => {
  const { name, locale, weight_current, weight_goal, height, age, sex, activity_level, dietary_restrictions } = req.body;
  const bmr = calcBMR({ weight_current, height, age, sex });
  const tdee = calcTDEE(bmr, activity_level || 'moderate');
  const calories_target = weight_goal && weight_current && weight_goal < weight_current ? tdee - 500 : tdee;
  const user = {
    id: genId(), name, locale: locale || 'cs',
    weight_current, weight_goal, height, age, sex,
    activity_level: activity_level || 'moderate',
    dietary_restrictions: dietary_restrictions || '',
    calories_target, created_at: new Date().toISOString(),
  };
  db.data.users.push(user);
  db.write();
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const idx = db.data.users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const d = req.body;
  const bmr = calcBMR(d);
  const tdee = calcTDEE(bmr, d.activity_level || 'moderate');
  const calories_target = d.weight_goal && d.weight_current && d.weight_goal < d.weight_current ? tdee - 500 : tdee;
  Object.assign(db.data.users[idx], d, { calories_target });
  db.write();
  res.json(db.data.users[idx]);
});

app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.data.users = db.data.users.filter(u => u.id !== id);
  db.data.meal_plans = db.data.meal_plans.filter(p => p.user_id !== id);
  db.data.chat_messages = db.data.chat_messages.filter(m => m.user_id !== id);
  db.data.shopping_lists = db.data.shopping_lists.filter(s => s.user_id !== id);
  db.write();
  res.json({ ok: true });
});

// ── API: Meal Plans ──────────────────────────────────────────────────
app.get('/api/plans/:userId/:weekStart', (req, res) => {
  const plan = db.data.meal_plans.find(p => p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart);
  res.json(plan || null);
});

app.post('/api/plans', (req, res) => {
  const { user_id, week_start, meals } = req.body;
  const idx = db.data.meal_plans.findIndex(p => p.user_id === user_id && p.week_start === week_start);
  if (idx >= 0) {
    db.data.meal_plans[idx].meals = meals;
    db.data.meal_plans[idx].updated_at = new Date().toISOString();
  } else {
    db.data.meal_plans.push({ id: genId(), user_id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  db.write();
  res.json({ ok: true });
});

app.delete('/api/plans/:userId/:weekStart', (req, res) => {
  db.data.meal_plans = db.data.meal_plans.filter(p => !(p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart));
  db.data.shopping_lists = db.data.shopping_lists.filter(s => !(s.user_id === parseInt(req.params.userId) && s.week_start === req.params.weekStart));
  db.write();
  res.json({ ok: true });
});

// ── API: Generate with AI ─────────────────────────────────────────────
app.post('/api/generate/:userId', async (req, res) => {
  const { week_start } = req.body;
  const user = db.data.users.find(u => u.id === parseInt(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const loc = getLocale(user.locale);
  const days = loc.dayNames;
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
- Reálné české suroviny dostupné v obchodech (Kaufland, Albert, Lidl)
- Vyvážené makroživiny (30% bílkoviny, 40% sacharidy, 30% tuky)
- Denní součet kalorií ~${targetCal} kcal
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
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    const plan = JSON.parse(content);
    const meals = {};
    plan.days.forEach((day, i) => {
      meals[i] = {
        day: day.day, total_calories: day.total_calories,
        total_protein: day.total_protein, total_carbs: day.total_carbs, total_fat: day.total_fat,
        meals: day.meals,
      };
    });

    const idx = db.data.meal_plans.findIndex(p => p.user_id === user.id && p.week_start === week_start);
    if (idx >= 0) {
      db.data.meal_plans[idx].meals = meals;
      db.data.meal_plans[idx].updated_at = new Date().toISOString();
    } else {
      db.data.meal_plans.push({ id: genId(), user_id: user.id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }

    db.data.chat_messages.push({ id: genId(), user_id: user.id, role: 'assistant', content: `Vygeneroval jsem jídelníček pro týden ${week_start}. Celkem ~${targetCal} kcal/den. Chceš něco změnit?`, created_at: new Date().toISOString() });
    db.write();

    res.json({ meals });
  } catch (err) {
    console.error('AI generation error:', err);
    res.status(500).json({ error: 'Failed to generate meal plan', details: err.message });
  }
});

// ── API: Chat with AI ─────────────────────────────────────────────────
app.get('/api/chat/:userId', (req, res) => {
  const msgs = db.data.chat_messages.filter(m => m.user_id === parseInt(req.params.userId)).slice(-100);
  res.json(msgs);
});

app.post('/api/chat/:userId', async (req, res) => {
  const { message, week_start } = req.body;
  const user = db.data.users.find(u => u.id === parseInt(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.data.chat_messages.push({ id: genId(), user_id: user.id, role: 'user', content: message, created_at: new Date().toISOString() });

  let currentPlan = null;
  if (week_start) {
    const row = db.data.meal_plans.find(p => p.user_id === user.id && p.week_start === week_start);
    if (row) currentPlan = row.meals;
  }

  const history = db.data.chat_messages.filter(m => m.user_id === user.id).slice(-20);

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
    let updatedPlan = null;

    if (content.includes('"meals"')) {
      try {
        const startIdx = content.indexOf('{"meals"');
        if (startIdx >= 0) {
          let jsonStr = content.substring(startIdx);
          let depth = 0, endIdx = 0;
          for (let i = 0; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') depth++;
            if (jsonStr[i] === '}') depth--;
            if (depth === 0) { endIdx = i + 1; break; }
          }
          jsonStr = jsonStr.substring(0, endIdx);
          const parsed = JSON.parse(jsonStr);
          if (parsed.meals) {
            updatedPlan = parsed.meals;
            const idx = db.data.meal_plans.findIndex(p => p.user_id === user.id && p.week_start === week_start);
            if (idx >= 0) {
              db.data.meal_plans[idx].meals = updatedPlan;
              db.data.meal_plans[idx].updated_at = new Date().toISOString();
            } else {
              db.data.meal_plans.push({ id: genId(), user_id: user.id, week_start, meals: updatedPlan, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            }
            content = content.substring(0, startIdx).trim() || 'Jídelníček byl aktualizován! ✅';
          }
        }
      } catch (e) { /* not valid JSON, treat as text */ }
    }

    db.data.chat_messages.push({ id: genId(), user_id: user.id, role: 'assistant', content, created_at: new Date().toISOString() });
    db.write();
    res.json({ message: content, updatedPlan });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI request failed', details: err.message });
  }
});

// ── API: Shopping List ────────────────────────────────────────────────
app.get('/api/shopping/:userId/:weekStart', (req, res) => {
  const uid = parseInt(req.params.userId);
  const ws = req.params.weekStart;
  const existing = db.data.shopping_lists.find(s => s.user_id === uid && s.week_start === ws);
  if (existing) return res.json(existing.items);

  const plan = db.data.meal_plans.find(p => p.user_id === uid && p.week_start === ws);
  if (!plan) return res.json([]);

  const items = {};
  Object.values(plan.meals).forEach(day => {
    Object.values(day.meals || {}).forEach(meal => {
      (meal.ingredients || []).forEach(ing => {
        const key = ing.toLowerCase().trim();
        if (!items[key]) items[key] = { name: ing, checked: false };
      });
    });
  });

  const list = Object.values(items).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  db.data.shopping_lists.push({ id: genId(), user_id: uid, week_start: ws, items: list, created_at: new Date().toISOString() });
  db.write();
  res.json(list);
});

app.put('/api/shopping/:userId/:weekStart', (req, res) => {
  const uid = parseInt(req.params.userId);
  const ws = req.params.weekStart;
  const idx = db.data.shopping_lists.findIndex(s => s.user_id === uid && s.week_start === ws);
  if (idx >= 0) {
    db.data.shopping_lists[idx].items = req.body.items;
  } else {
    db.data.shopping_lists.push({ id: genId(), user_id: uid, week_start: ws, items: req.body.items, created_at: new Date().toISOString() });
  }
  db.write();
  res.json({ ok: true });
});

// ── API: Prep Guide ───────────────────────────────────────────────────
app.get('/api/prep/:userId/:weekStart', (req, res) => {
  const plan = db.data.meal_plans.find(p => p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart);
  if (!plan) return res.json({ days: [] });

  const prep = { days: [] };
  Object.values(plan.meals).forEach(day => {
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
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Jídelníček running on :${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
