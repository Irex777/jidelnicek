// ═══════════════════════════════════════════════════════════════════════
// Plan routes — CRUD, generation (day, week, async, status)
// ═══════════════════════════════════════════════════════════════════════

const { queryAll, queryOne, runDb } = require('../db');
const { planToJSON, DAY_NAMES_CS, addDays, getDayIndex, getWeekStart } = require('../utils');
const {
  AI_KEY, AiConfigError, isAiConfigError, generateDayPlan, extractMealNames,
} = require('../ai');

// ── Helpers ──────────────────────────────────────────────────────────
function sendAiConfigError(res) {
  return res.status(503).json({ error: new AiConfigError().message, code: 'AI_NOT_CONFIGURED' });
}

function invalidateShoppingListsForUser(userId) {
  runDb('DELETE FROM shopping_lists WHERE user_id = ?', [userId]);
}

function invalidateMealDetailsForPlan(planId) {
  runDb('DELETE FROM meal_details WHERE plan_id = ?', [planId]);
}

// Shared: upsert a generated day plan into DB
function upsertPlan(userId, date, dayPlan) {
  const dayIdx = getDayIndex(date);
  const dayName = DAY_NAMES_CS[dayIdx];
  const mealsJson = JSON.stringify(dayPlan.meals);

  const existing = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);
  let planId;
  if (existing) {
    runDb(
      `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
      [dayPlan.day || dayName, dayPlan.total_calories || 0, dayPlan.total_protein || 0,
       dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson, existing.id]
    );
    planId = existing.id;
  } else {
    planId = runDb(
      `INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, date, dayPlan.day || dayName, dayPlan.total_calories || 0,
       dayPlan.total_protein || 0, dayPlan.total_carbs || 0, dayPlan.total_fat || 0, mealsJson]
    );
  }
  invalidateShoppingListsForUser(userId);
  invalidateMealDetailsForPlan(planId);
  return planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]));
}

// Background generation status (in-memory)
const genStatus = new Map(); // key: "userId:weekStart", value: { status, completed, total, errors[] }

function getGenKey(userId, weekStart) {
  return `${userId}:${weekStart}`;
}

// Core generation logic — runs fully in background
async function runWeekGeneration(userId, weekStart) {
  const key = getGenKey(userId, weekStart);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    genStatus.set(key, { status: 'error', completed: 0, total: 7, errors: ['User not found'] });
    return;
  }

  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDays(weekStart, i));

  const prevMealNames = [];
  for (let i = 1; i <= 4; i++) {
    const prevDate = addDays(weekStart, -i);
    const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
    if (prevPlan) prevMealNames.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
  }

  genStatus.set(key, { status: 'generating', completed: 0, total: 7, errors: [] });
  console.log(`[GEN] Started background week generation for ${key}`);

  const promises = dates.map((date, idx) => {
    const dayName = DAY_NAMES_CS[getDayIndex(date)];
    return generateDayPlan(user, date, prevMealNames)
      .then(dayPlan => {
        upsertPlan(userId, date, dayPlan);
        console.log(`[GEN] ${key} day ${idx + 1}/7 done: ${dayName} ${dayPlan.total_calories} kcal`);
        const s = genStatus.get(key);
        if (s) { s.completed++; genStatus.set(key, s); }
      })
      .catch(err => {
        console.error(`[GEN] ${key} day ${idx + 1}/7 failed: ${err.message}`);
        const s = genStatus.get(key);
        if (s) { s.errors.push({ day: idx, name: dayName, date, error: err.message }); s.completed++; genStatus.set(key, s); }
      });
  });

  await Promise.all(promises);
  const final = genStatus.get(key);
  if (final) { final.status = 'complete'; genStatus.set(key, final); }
  console.log(`[GEN] Finished background week generation for ${key}: ${final?.completed || '?'}/7 done`);
}

// ── Routes ───────────────────────────────────────────────────────────
function register(app) {
  // ── Get plans ──
  app.get('/api/plan/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Profil nenalezen' });

    const { from, to } = req.query;
    if (from && to) {
      const rows = queryAll('SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date', [userId, from, to]);
      return res.json(rows.map(planToJSON));
    }
    const rows = queryAll('SELECT * FROM meal_plans WHERE user_id = ? ORDER BY date DESC', [userId]);
    res.json(rows.map(planToJSON));
  });

  // ── Edit plan ──
  app.put('/api/plan/:planId', (req, res) => {
    const planId = parseInt(req.params.planId);
    const d = req.body;
    const existing = queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });

    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [existing.user_id, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Plan not found' });

    let meals = JSON.parse(existing.meals_json);
    if (d.meals) meals = d.meals;

    let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;
    for (const meal of Object.values(meals)) {
      totalCal += meal.calories || 0;
      totalP += meal.protein || 0;
      totalC += meal.carbs || 0;
      totalF += meal.fat || 0;
    }

    runDb(
      `UPDATE meal_plans SET day_name=?, total_calories=?, total_protein=?, total_carbs=?, total_fat=?, meals_json=?, updated_at=datetime('now') WHERE id=?`,
      [d.day_name || existing.day_name, d.total_calories || totalCal, d.total_protein || totalP,
       d.total_carbs || totalC, d.total_fat || totalF, JSON.stringify(meals), planId]
    );
    invalidateMealDetailsForPlan(planId);
    invalidateShoppingListsForUser(existing.user_id);
    res.json(planToJSON(queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId])));
  });

  // ── Delete plan ──
  app.delete('/api/plan/:planId', (req, res) => {
    const planId = parseInt(req.params.planId);
    const existing = queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]);
    if (!existing) return res.status(404).json({ error: 'Plan not found' });

    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [existing.user_id, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Plan not found' });
    runDb('DELETE FROM meal_plans WHERE id = ?', [planId]);
    invalidateShoppingListsForUser(existing.user_id);
    res.json({ ok: true });
  });

  // ── Generate single day ──
  app.post('/api/generate-day', async (req, res) => {
    const { userId, date } = req.body;
    if (!userId || !date) return res.status(400).json({ error: 'userId and date required' });
    if (!AI_KEY) return sendAiConfigError(res);

    const user = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const prevDays = [];
    for (let i = 1; i <= 4; i++) {
      const prevDate = addDays(date, -i);
      const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
      if (prevPlan) prevDays.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
    }

    try {
      const dayPlan = await generateDayPlan(user, date, prevDays);
      res.json(upsertPlan(userId, date, dayPlan));
    } catch (err) {
      console.error(`[AI] generate-day error: ${err.message}`);
      if (isAiConfigError(err)) return sendAiConfigError(res);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Generate week async (fire & forget) ──
  app.post('/api/generate-week-async', (req, res) => {
    const { userId, weekStart } = req.body;
    if (!userId || !weekStart) return res.status(400).json({ error: 'userId and weekStart required' });
    if (!AI_KEY) return sendAiConfigError(res);

    const user = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const key = getGenKey(userId, weekStart);
    const existing = genStatus.get(key);
    if (existing && existing.status === 'generating') {
      return res.json({ status: 'already_generating', key, completed: existing.completed, total: existing.total });
    }

    runWeekGeneration(userId, weekStart).catch(err => {
      console.error(`[GEN] Fatal error for ${key}:`, err.message);
      genStatus.set(key, { status: 'error', completed: 0, total: 7, errors: [{ error: err.message }] });
    });

    res.json({ status: 'started', key, completed: 0, total: 7 });
  });

  // ── Generation status (poll endpoint) ──
  app.get('/api/generate-status/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const weekStart = req.query.weekStart;
    if (!weekStart) return res.status(400).json({ error: 'weekStart query param required' });

    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Profil nenalezen' });

    const status = genStatus.get(getGenKey(userId, weekStart));
    const days = [];
    let completed = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const plan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, date]);
      const dayError = status?.errors?.find(e => e.day === i);

      if (plan) {
        days.push({ date, index: i, status: 'done', calories: plan.total_calories || 0 });
        completed++;
      } else if (dayError) {
        days.push({ date, index: i, status: 'error', error: dayError.error });
        completed++;
      } else if (status && status.status === 'generating') {
        days.push({ date, index: i, status: 'generating' });
      } else {
        days.push({ date, index: i, status: 'pending' });
      }
    }

    if (!status) {
      return res.json({ status: completed === 7 ? 'complete' : 'none', completed, total: 7, errors: [], days });
    }
    res.json({ status: status.status, completed, total: status.total, errors: status.errors, days });
  });

  // ── Generate week (parallel, SSE) — legacy ──
  app.post('/api/generate-week', async (req, res) => {
    const { userId, weekStart } = req.body;
    if (!userId || !weekStart) return res.status(400).json({ error: 'userId and weekStart required' });
    if (!AI_KEY) return sendAiConfigError(res);

    const user = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

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

    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(addDays(weekStart, i));

    const prevMealNames = [];
    for (let i = 1; i <= 4; i++) {
      const prevDate = addDays(weekStart, -i);
      const prevPlan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, prevDate]);
      if (prevPlan) prevMealNames.push(...extractMealNames(JSON.parse(prevPlan.meals_json)));
    }

    const promises = dates.map((date, idx) => {
      const dayName = DAY_NAMES_CS[getDayIndex(date)];
      return generateDayPlan(user, date, prevMealNames)
        .then(dayPlan => {
          const plan = upsertPlan(userId, date, dayPlan);
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
      safeWrite(`data: ${JSON.stringify({ type: 'complete', total: results.filter(Boolean).length })}\n\n`);
    } catch (err) {
      safeWrite(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    if (clientConnected) res.end();
  });
}

module.exports = { register, upsertPlan, invalidateShoppingListsForUser, invalidateMealDetailsForPlan };
