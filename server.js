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
// Model config: { name, timeout (ms), retries }
// Day-by-day generation means each request is small (~2000 tokens) — glm-5-turbo can handle this
const AI_MODEL_CONFIG = [
  { name: 'GLM-5-Turbo', timeout: 30000, retries: 1 },   // 30s — fast, cheap
  { name: 'GLM-4.5-Air', timeout: 60000, retries: 2 },   // 1min — reliable fallback
  { name: 'GLM-4.7', timeout: 60000, retries: 1 },       // fallback
];
const ai = new OpenAI({
  apiKey: process.env.ZAI_API_KEY || '',
  baseURL: AI_BASE_URL,
});
console.log(`[AI] models=${AI_MODEL_CONFIG.map(m=>m.name).join(',')} baseURL=${AI_BASE_URL}`);

// Try models in order with per-model timeout and retries
async function aiGenerate(messages, maxTokens, temperature) {
  for (const cfg of AI_MODEL_CONFIG) {
    for (let attempt = 1; attempt <= cfg.retries; attempt++) {
      try {
        console.log(`[AI] Trying ${cfg.name} (attempt ${attempt}/${cfg.retries}, timeout ${cfg.timeout}ms)`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);
        const completion = await ai.chat.completions.create(
          { model: cfg.name, messages, temperature, max_tokens: maxTokens },
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        const content = (completion.choices[0].message.content || '').trim();
        if (!content) {
          console.log(`[AI] ${cfg.name} returned empty content, trying next model...`);
          break; // skip retries for this model, move to next
        }
        console.log(`[AI] ${cfg.name} returned ${content.length} chars (attempt ${attempt})`);
        return { content, model: cfg.name };
      } catch (err) {
        console.log(`[AI] ${cfg.name} attempt ${attempt} failed: ${err.message}`);
        if (attempt < cfg.retries) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // backoff
        }
      }
    }
  }
  throw new Error('All AI models failed. Please try again later.');
}

// Fast model for chat (short responses — GLM-5-Turbo is great for this)
const CHAT_MODEL_CONFIG = [
  { name: 'GLM-5-Turbo', timeout: 30000, retries: 2 },   // 30s — fast for short responses
  { name: 'GLM-4.5-Air', timeout: 60000, retries: 1 },   // fallback
];

async function aiChatGenerate(messages, maxTokens, temperature) {
  for (const cfg of CHAT_MODEL_CONFIG) {
    for (let attempt = 1; attempt <= cfg.retries; attempt++) {
      try {
        console.log(`[AI-Chat] Trying ${cfg.name} (attempt ${attempt}/${cfg.retries})`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);
        const completion = await ai.chat.completions.create(
          { model: cfg.name, messages, temperature, max_tokens: maxTokens },
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);
        const content = (completion.choices[0].message.content || '').trim();
        if (!content) { break; }
        console.log(`[AI-Chat] ${cfg.name} returned ${content.length} chars`);
        return { content, model: cfg.name };
      } catch (err) {
        console.log(`[AI-Chat] ${cfg.name} attempt ${attempt} failed: ${err.message}`);
        if (attempt < cfg.retries) { await new Promise(r => setTimeout(r, 2000 * attempt)); }
      }
    }
  }
  throw new Error('Chat AI failed. Please try again.');
}

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
app.get('/api/debug', (req, res) => res.json({ models: AI_MODEL_CONFIG.map(m => ({ name: m.name, timeout: m.timeout, retries: m.retries })), baseURL: AI_BASE_URL, hasKey: !!(process.env.ZAI_API_KEY), keyPreview: (process.env.ZAI_API_KEY || '').substring(0, 8) + '...' }));

// Quick AI test endpoint
app.get('/api/test-ai', async (req, res) => {
  try {
    const { content, model } = await aiGenerate([{ role: 'user', content: 'Řekni ahoj jedním slovem' }], 100, 0.5);
    res.json({ ok: true, model, response: content });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});
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

// ── API: Generate with AI (day-by-day, each saved immediately) ────────
const pendingJobs = {};

app.post('/api/generate/:userId', async (req, res) => {
  const { week_start } = req.body;
  const user = find('users', u => u.id === parseInt(req.params.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Check if plan already exists for this week — don't regenerate
  const existing = find('meal_plans', p => p.user_id === user.id && p.week_start === week_start);
  if (existing && existing.meals && Object.keys(existing.meals).length >= 7) {
    return res.json({ jobId: null, status: 'exists', meals: existing.meals });
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingJobs[jobId] = { status: 'pending', progress: 0, total: 7, result: null, error: null, partialMeals: {} };
  res.json({ jobId, status: 'pending' });

  // Run day-by-day generation in background
  (async () => {
    const loc = getLocale(user.locale);
    const targetCal = user.calories_target || 2000;
    const meals = {};

    // Restore any partial progress from existing plan
    if (existing && existing.meals) {
      Object.assign(meals, existing.meals);
    }

    const daysToGenerate = [];
    for (let i = 0; i < 7; i++) {
      if (!meals[i]) daysToGenerate.push(i);
    }

    console.log(`[AI] Starting day-by-day generation for user ${user.id}, ${daysToGenerate.length} days to generate`);

    for (const dayIdx of daysToGenerate) {
      const dayName = loc.dayNames[dayIdx];
      // Build context from already-generated days so meals don't repeat
      const prevMeals = Object.values(meals).map(d => d.meals ? Object.values(d.meals).map(m => m.name).join(', ') : '').filter(Boolean);
      const contextStr = prevMeals.length > 0 ? `\nJiž navržená jídla (NEOPAKUJ): ${prevMeals.join(' | ')}` : '';

      const prompt = `Jsi profesionální výživový poradce. Vytvoř JEDEN den (${dayName}) jídelníčku v JSON.

Uživatel: ${user.name}, ${user.sex==='male'?'muž':user.sex==='female'?'žena':'?'}, ${user.age||'?'} let, ${user.weight_current||'?'}kg → ${user.weight_goal||'?'}kg
Aktivita: ${user.activity_level||'moderate'}, diety: ${user.dietary_restrictions||'žádné'}
Cíl: ${targetCal} kcal/den, max 30min příprava.${contextStr}

Vrať POUZE valid JSON bez markdown:
{"day":"${dayName}","total_calories":N,"total_protein":N,"total_carbs":N,"total_fat":N,"meals":{"breakfast":{"name":"...","calories":N,"protein":N,"carbs":N,"fat":N,"ingredients":["položka s množstvím"],"prep":"stručný postup"},"morning_snack":{...},"lunch":{...},"afternoon_snack":{...},"dinner":{...}}}

Pravidla: české suroviny, 30% bílkoviny/40% sacharidy/30% tuky. Rozložení: snídaně~22%, dop. svačina~8%, oběd~30%, odp. svačina~8%, večeře~32%.`;

      try {
        console.log(`[AI] Generating day ${dayIdx+1}/7: ${dayName}`);
        const { content: rawContent, model } = await aiGenerate(
          [{ role: 'user', content: prompt }], 4000, 0.8
        );
        let content = rawContent.replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/i,'').trim();
        const dayPlan = JSON.parse(content);

        meals[dayIdx] = {
          day: dayPlan.day || dayName,
          total_calories: dayPlan.total_calories,
          total_protein: dayPlan.total_protein,
          total_carbs: dayPlan.total_carbs,
          total_fat: dayPlan.total_fat,
          meals: dayPlan.meals
        };

        // Save progress after EACH day — survives crashes
        const existingPlan = find('meal_plans', p => p.user_id === user.id && p.week_start === week_start);
        if (existingPlan) {
          updateOne('meal_plans', p => p.id === existingPlan.id, { meals, updated_at: new Date().toISOString() });
        } else {
          push('meal_plans', { id: genId(), user_id: user.id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }

        const done = Object.keys(meals).length;
        pendingJobs[jobId] = {
          status: done >= 7 ? 'done' : 'pending',
          progress: done, total: 7,
          result: done >= 7 ? { meals } : null,
          partialMeals: done < 7 ? { ...meals } : null,
          error: null
        };
        console.log(`[AI] Day ${dayIdx+1}/7 done (${model}): ${dayPlan.total_calories} kcal`);

      } catch (err) {
        console.error(`[AI] Day ${dayIdx+1}/7 failed:`, err.message);
        // If we have at least some days, save what we have and report partial success
        if (Object.keys(meals).length > 0) {
          const existingPlan = find('meal_plans', p => p.user_id === user.id && p.week_start === week_start);
          if (existingPlan) {
            updateOne('meal_plans', p => p.id === existingPlan.id, { meals, updated_at: new Date().toISOString() });
          } else {
            push('meal_plans', { id: genId(), user_id: user.id, week_start, meals, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
          }
          pendingJobs[jobId] = {
            status: 'done',
            progress: Object.keys(meals).length, total: 7,
            result: { meals },
            partialMeals: null,
            error: `Vygenerováno ${Object.keys(meals).length}/7 dní. Zkuste znovu pro doplnění chybějících dnů.`
          };
        } else {
          pendingJobs[jobId] = { status: 'error', progress: 0, total: 7, result: null, error: err.message || 'AI generation failed' };
        }
        return;
      }
    }

    // All 7 days done
    push('chat_messages', { id: genId(), user_id: user.id, role: 'assistant', content: `Vygeneroval jsem jídelníček pro týden ${week_start} (~${targetCal} kcal/den).`, created_at: new Date().toISOString() });
    console.log(`[AI] Complete plan saved for user ${user.id}, week ${week_start}`);
  })();
});

app.get('/api/generate-status/:jobId', (req, res) => {
  const job = pendingJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status === 'done' || job.status === 'error') delete pendingJobs[req.params.jobId];
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
    const { content } = await aiChatGenerate(
      [{ role: 'system', content: systemMsg }, ...history.map(m => ({ role: m.role, content: m.content }))],
      4000, 0.7
    );
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
