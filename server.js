const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database (simple JSON file) ───────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'db.json');
const defaults = { users: [], meal_plans: [], chat_messages: [], shopping_lists: [], _nextId: 1 };

function readDb() {
  try {
    if (!fs.existsSync(dbFile)) return JSON.parse(JSON.stringify(defaults));
    const d = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    for (const k of Object.keys(defaults)) { if (!(k in d)) d[k] = defaults[k]; }
    return d;
  } catch { return JSON.parse(JSON.stringify(defaults)); }
}
function writeDb(data) { fs.writeFileSync(dbFile, JSON.stringify(data, null, 2)); }
function genId() { const d = readDb(); const id = (d._nextId || 1); d._nextId = id + 1; writeDb(d); return id; }
function push(collection, item) { const d = readDb(); d[collection].push(item); writeDb(d); }
function find(collection, fn) { return readDb()[collection].find(fn) || null; }
function filter(collection, fn) { return readDb()[collection].filter(fn); }
function updateOne(collection, fn, updates) { const d = readDb(); const idx = d[collection].findIndex(fn); if (idx >= 0) { Object.assign(d[collection][idx], updates); writeDb(d); return d[collection][idx]; } return null; }
function removeWhere(collection, fn) { const d = readDb(); d[collection] = d[collection].filter((item, i) => !fn(item, i)); writeDb(d); }

// ── AI Client ─────────────────────────────────────────────────────────
const AI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
const AI_MODEL_NAME = 'glm-4.5';
const ai = new OpenAI({
  apiKey: process.env.ZAI_API_KEY || '',
  baseURL: AI_BASE_URL,
});
const AI_MODEL = AI_MODEL_NAME;
console.log(`[AI] model=${AI_MODEL} baseURL=${AI_BASE_URL}`);

// ── Localization ──────────────────────────────────────────────────────
const LOCALES = {
  cs: { dayNames: ['Pondělí','Úterý','Středa','Čtvrtek','Pátek','Sobota','Neděle'], mealTypes: { breakfast:'Snídaně', morning_snack:'Dop. svačina', lunch:'Oběd', afternoon_snack:'Odp. svačina', dinner:'Večeře' } },
  en: { dayNames: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], mealTypes: { breakfast:'Breakfast', morning_snack:'Morning snack', lunch:'Lunch', afternoon_snack:'Afternoon snack', dinner:'Dinner' } },
};
function getLocale(lang) { return LOCALES[lang] || LOCALES.cs; }

// ── Helpers ───────────────────────────────────────────────────────────
function calcBMR(u) {
  if (!u.weight_current || !u.height || !u.age || !u.sex) return 2000;
  return u.sex === 'male' ? Math.round(10*u.weight_current + 6.25*u.height - 5*u.age + 5) : Math.round(10*u.weight_current + 6.25*u.height - 5*u.age - 161);
}
function calcTDEE(bmr, level) { return Math.round(bmr * ({sedentary:1.2,light:1.375,moderate:1.55,active:1.725,very_active:1.9}[level]||1.55)); }

// ── API: Users ────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => res.json({ model: AI_MODEL, baseURL: AI_BASE_URL, hasKey: !!(process.env.ZAI_API_KEY) }));
app.get('/api/users', (req, res) => res.json(readDb().users));

app.post('/api/users', (req, res) => {
  const d = req.body;
  const bmr = calcBMR(d);
  const tdee = calcTDEE(bmr, d.activity_level || 'moderate');
  const calories_target = d.weight_goal && d.weight_current && d.weight_goal < d.weight_current ? tdee - 500 : tdee;
  const user = { id: genId(), name: d.name, locale: d.locale||'cs', weight_current: d.weight_current, weight_goal: d.weight_goal, height: d.height, age: d.age, sex: d.sex, activity_level: d.activity_level||'moderate', dietary_restrictions: d.dietary_restrictions||'', calories_target, created_at: new Date().toISOString() };
  push('users', user);
  res.json(user);
});

app.put('/api/users/:id', (req, res) => {
  const d = req.body;
  const bmr = calcBMR(d);
  const tdee = calcTDEE(bmr, d.activity_level || 'moderate');
  d.calories_target = d.weight_goal && d.weight_current && d.weight_goal < d.weight_current ? tdee - 500 : tdee;
  const u = updateOne('users', u => u.id === parseInt(req.params.id), d);
  u ? res.json(u) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  removeWhere('users', u => u.id === id);
  removeWhere('meal_plans', p => p.user_id === id);
  removeWhere('chat_messages', m => m.user_id === id);
  removeWhere('shopping_lists', s => s.user_id === id);
  res.json({ ok: true });
});

// ── API: Meal Plans ──────────────────────────────────────────────────
app.get('/api/plans/:userId/:weekStart', (req, res) => {
  res.json(find('meal_plans', p => p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart) || null);
});

app.post('/api/plans', (req, res) => {
  const { user_id, week_start, meals } = req.body;
  const existing = find('meal_plans', p => p.user_id === user_id && p.week_start === week_start);
  if (existing) {
    updateOne('meal_plans', p => p.user_id === user_id && p.week_start === week_start, { meals, updated_at: new Date().toISOString() });
  } else {
    push('meal_plans', { id: genId(), user_id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  res.json({ ok: true });
});

app.delete('/api/plans/:userId/:weekStart', (req, res) => {
  removeWhere('meal_plans', p => p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart);
  removeWhere('shopping_lists', s => s.user_id === parseInt(req.params.userId) && s.week_start === req.params.weekStart);
  res.json({ ok: true });
});

// ── API: Generate with AI (async) ─────────────────────────────────────
const pendingJobs = {};

app.post('/api/generate/:userId', async (req, res) => {
  const { week_start } = req.body;
  const user = find('users', u => u.id === parseInt(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingJobs[jobId] = { status: 'pending', result: null, error: null };
  res.json({ jobId, status: 'pending' });

  // Run generation in background
  (async () => {
    const loc = getLocale(user.locale);
    const targetCal = user.calories_target || 2000;
    const prompt = `Jsi profesionální výživový poradce. Vytvoř týdenní jídelníček v JSON formátu.

Uživatel: ${user.name}
Váha: ${user.weight_current||'?'}kg → ${user.weight_goal||'?'}kg, výška: ${user.height||'?'}cm, věk: ${user.age||'?'}, ${user.sex==='male'?'muž':user.sex==='female'?'žena':'?'}
Aktivita: ${user.activity_level||'moderate'}, diety: ${user.dietary_restrictions||'žádné'}
Cíl: ${targetCal} kcal/den

Vrať POUZE valid JSON bez markdown:
{"days":[{"day":"${loc.dayNames[0]}","total_calories":N,"total_protein":N,"total_carbs":N,"total_fat":N,"meals":{"breakfast":{"name":"...","calories":N,"protein":N,"carbs":N,"fat":N,"ingredients":["položka s množstvím"],"prep":"stručný postup"},"morning_snack":{...},"lunch":{...},"afternoon_snack":{...},"dinner":{...}}}...7 days]}

Pravidla: české suroviny, 30% bílkoviny/40% sacharidy/30% tuky, ~${targetCal}kcal/den, max 30min příprava.`;
    try {
      const completion = await ai.chat.completions.create({ model: AI_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.8, max_tokens: 8000, timeout: 180000 });
      let content = completion.choices[0].message.content.trim().replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/i,'').trim();
      const plan = JSON.parse(content);
      const meals = {};
      plan.days.forEach((day, i) => { meals[i] = { day: day.day, total_calories: day.total_calories, total_protein: day.total_protein, total_carbs: day.total_carbs, total_fat: day.total_fat, meals: day.meals }; });

      const existing = find('meal_plans', p => p.user_id === user.id && p.week_start === week_start);
      if (existing) { updateOne('meal_plans', p => p.id === existing.id, { meals, updated_at: new Date().toISOString() }); }
      else { push('meal_plans', { id: genId(), user_id: user.id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }
      push('chat_messages', { id: genId(), user_id: user.id, role: 'assistant', content: `Vygeneroval jsem jídelníček pro týden ${week_start} (~${targetCal} kcal/den).`, created_at: new Date().toISOString() });
      pendingJobs[jobId] = { status: 'done', result: { meals } };
    } catch (err) {
      console.error('AI error:', err.message || err);
      pendingJobs[jobId] = { status: 'error', error: err.message || 'AI generation failed. The API may be temporarily unavailable. Please try again in a moment.' };
    }
  })();
});

app.get('/api/generate-status/:jobId', (req, res) => {
  const job = pendingJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status !== 'pending') delete pendingJobs[req.params.jobId];
});

// ── API: Chat ─────────────────────────────────────────────────────────
app.get('/api/chat/:userId', (req, res) => res.json(filter('chat_messages', m => m.user_id === parseInt(req.params.userId)).slice(-100)));

app.post('/api/chat/:userId', async (req, res) => {
  const { message, week_start } = req.body;
  const user = find('users', u => u.id === parseInt(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  push('chat_messages', { id: genId(), user_id: user.id, role: 'user', content: message, created_at: new Date().toISOString() });

  const currentPlan = week_start ? (find('meal_plans', p => p.user_id === user.id && p.week_start === week_start) || {}).meals : null;
  const history = filter('chat_messages', m => m.user_id === user.id).slice(-20);

  const systemMsg = `Jsi výživový poradce pro ${user.name}. Cíl: ${user.calories_target||2000}kcal. Diety: ${user.dietary_restrictions||'žádné'}.
${currentPlan ? 'Aktuální plán:\n'+JSON.stringify(currentPlan,null,2) : 'Žádný plán.'}
Pokud měníš jídelníček, vrať JSON: {"meals":{"0":{"day":"...","total_calories":N,...,"meals":{...}},...}}. Jinak vrať text.`;

  try {
    const completion = await ai.chat.completions.create({ model: AI_MODEL, messages: [{ role: 'system', content: systemMsg }, ...history.map(m => ({ role: m.role, content: m.content }))], temperature: 0.7, max_tokens: 4000, stream: false, timeout: 60000 });
    let content = completion.choices[0].message.content.trim();
    let updatedPlan = null;
    if (content.includes('"meals"')) {
      try {
        const si = content.indexOf('{"meals"');
        if (si >= 0) {
          let js = content.substring(si); let depth=0,ei=0;
          for (let i=0;i<js.length;i++){if(js[i]==='{')depth++;if(js[i]==='}'){depth--;if(depth===0){ei=i+1;break;}}}
          js = js.substring(0,ei);
          const parsed = JSON.parse(js);
          if (parsed.meals) {
            updatedPlan = parsed.meals;
            const existing = find('meal_plans', p => p.user_id === user.id && p.week_start === week_start);
            if (existing) { updateOne('meal_plans', p => p.id === existing.id, { meals: updatedPlan, updated_at: new Date().toISOString() }); }
            else { push('meal_plans', { id: genId(), user_id: user.id, week_start, meals: updatedPlan, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }
            content = content.substring(0,si).trim() || 'Jídelníček aktualizován! ✅';
          }
        }
      } catch {}
    }
    push('chat_messages', { id: genId(), user_id: user.id, role: 'assistant', content, created_at: new Date().toISOString() });
    res.json({ message: content, updatedPlan });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI failed', details: err.message });
  }
});

// ── API: Shopping List ────────────────────────────────────────────────
app.get('/api/shopping/:userId/:weekStart', (req, res) => {
  const uid = parseInt(req.params.userId), ws = req.params.weekStart;
  const existing = find('shopping_lists', s => s.user_id === uid && s.week_start === ws);
  if (existing) return res.json(existing.items);
  const plan = find('meal_plans', p => p.user_id === uid && p.week_start === ws);
  if (!plan) return res.json([]);

  // Parse ingredient: handles both "kuřecí prsa 200g" and "200g kuřecích prsou"
  const parseIng = (s) => {
    const raw = s.trim();
    // Try "name qty unit" format: "ovesné vločky 50g"
    let m = raw.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?$/i);
    if (m) {
      let unit = normalizeUnit(m[3] || 'ks');
      return { name: m[1].trim(), qty: parseFloat(m[2].replace(',','.')), unit };
    }
    // Try "qty unit name" format: "150g kuřecích prsou", "3 vejce", "1 lžíce medu"
    m = raw.match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|ks|lžíce|lžičky|lžička|lžiček|štípnutí|stroužek|balení|svazek|polévková lžíce)?\s+(.+)$/i);
    if (m) {
      let unit = normalizeUnit(m[2] || 'ks');
      return { name: m[3].trim(), qty: parseFloat(m[1].replace(',','.')), unit };
    }
    return { name: raw, qty: 0, unit: '' };
  };

  const normalizeUnit = (u) => {
    const l = (u || 'ks').toLowerCase();
    if (['lžíce','lžičky','lžička','lžiček','polévková lžíce'].includes(l)) return 'lžíce';
    if (['stroužek','stroužky'].includes(l)) return 'stroužky';
    return l;
  };

  // Category mapping (Czech)
  const categorize = (name) => {
    const n = name.toLowerCase();
    const cats = [
      [/maso|kuře|krůt|vepřov|hověz|losos|tuňák|candát|treska|slanina|šunka|mleté/, '🥩 Maso a ryby'],
      [/sýr|eidam|parmaz|cottage|lučina|tvaroh|mozzarell/, '🧀 Sýry'],
      [/jogurt|mléko|smetana|kefír/, '🥛 Mléčné'],
      [/vejce/, '🥚 Vejce'],
      [/chléb|chleb|toast|knäckebrot|tortilla|polenta/, '🍞 Pečivo'],
      [/rýže|těstovin|kuskus|quinoa|pohanka|vločky|mouka|knedlík/, '🌾 Obiloviny'],
      [/banán|jablk|jablk|jahod|borůvk|malin|hrozn|ovoc|citrus|citrón|pomeranč/, '🍎 Ovoce'],
      [/okurk|rajč|paprik|brokolic|špenát|cuket|salát|ředkvič|mrkev|cibul|oliv|zelí|luštěnin|fazol|hrášek|zelenin|avokád/, '🥬 Zelenina'],
      [/protein|whey|srvát/, '💪 Protein'],
      [/olej|máslo|med|sirup|arašídové máslo/, '🧈 Tuky a sladidla'],
      [/omáčka|protlak|dresink|sójo|ocet|kření|koření|bylink|sůl|pepř/, '🧂 Koření a omáčky'],
      [/tyčink|pudink/, '🍫 Sladkosti'],
    ];
    for (const [re, cat] of cats) { if (re.test(n)) return cat; }
    return '📦 Ostatní';
  };

  // Collect and merge all ingredients across all days/meals
  const merged = {};
  // For fuzzy matching: strip adjectives and find canonical base name
  const baseName = (n) => {
    return n.toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, '')  // remove parenthetical notes
      .replace(/\b(syrov[éý]|čerstv[éeý]|mražen[éeý]|grilovan[éeý]|vařen[éeý]|pečen[éeý]|celozrnn[éeý]|odtučněn[éeý]|polotučn[éeý]|libov[éeý]|hladké|na ozdobu|bez kůže|ve vlastní šťávě)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
  };

  Object.values(plan.meals).forEach(day => {
    Object.values(day.meals || {}).forEach(meal => {
      (meal.ingredients || []).forEach(raw => {
        const p = parseIng(raw);
        // Find best matching key
        const bn = baseName(p.name);
        let bestKey = null, bestScore = 0;
        for (const existingKey of Object.keys(merged)) {
          const eb = baseName(existingKey);
          // Exact base match
          if (eb === bn) { bestKey = existingKey; bestScore = 1; break; }
          // One contains the other (substantive match)
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
          const key = p.name.toLowerCase();
          merged[key] = { name: p.name, qty: p.qty, unit: p.unit, category: categorize(p.name), checked: false };
        }
      });
    });
  });

  // Format display name with merged quantities
  const list = Object.values(merged).map(item => {
    let display = item.name;
    if (item.qty > 0) {
      // Pretty-print qty
      const q = item.qty % 1 === 0 ? item.qty : item.qty.toFixed(1).replace('.0','');
      display += ` ${q} ${item.unit}`;
    }
    if (item.also) display += ` + ${item.also.join(' + ')}`;
    return { ...item, display };
  });

  // Sort by category, then name
  list.sort((a, b) => a.category.localeCompare(b.category, 'cs') || a.name.localeCompare(b.name, 'cs'));

  push('shopping_lists', { id: genId(), user_id: uid, week_start: ws, items: list, created_at: new Date().toISOString() });
  res.json(list);
});

app.put('/api/shopping/:userId/:weekStart', (req, res) => {
  const uid = parseInt(req.params.userId), ws = req.params.weekStart;
  const existing = find('shopping_lists', s => s.user_id === uid && s.week_start === ws);
  if (existing) { updateOne('shopping_lists', s => s.id === existing.id, { items: req.body.items }); }
  else { push('shopping_lists', { id: genId(), user_id: uid, week_start: ws, items: req.body.items, created_at: new Date().toISOString() }); }
  res.json({ ok: true });
});

// ── API: Prep Guide ───────────────────────────────────────────────────
app.get('/api/prep/:userId/:weekStart', (req, res) => {
  const plan = find('meal_plans', p => p.user_id === parseInt(req.params.userId) && p.week_start === req.params.weekStart);
  if (!plan) return res.json({ days: [] });
  res.json({ days: Object.values(plan.meals).map(day => ({ day: day.day, meals: Object.entries(day.meals||{}).map(([type, meal]) => ({ type, name: meal.name, prep: meal.prep, ingredients: meal.ingredients })) })) });
});

// ── Spa fallback ──────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Jídelníček running on :${PORT}`));
process.on('uncaughtException', err => console.error('Uncaught:', err.message));
