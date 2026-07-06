// ═══════════════════════════════════════════════════════════════════════
// Meal detail routes — AI-generated recipe + cookware (cached)
// ═══════════════════════════════════════════════════════════════════════

const { queryOne, runDb } = require('../db');
const { AI_KEY, getAiClient, AiConfigError } = require('../ai');

function sendAiConfigError(res) {
  return res.status(503).json({ error: new AiConfigError().message, code: 'AI_NOT_CONFIGURED' });
}

function isAiConfigError(err) {
  return err instanceof AiConfigError || err?.status === 503 || err?.code === 'AI_NOT_CONFIGURED';
}

function register(app) {
  app.post('/api/meal-detail', async (req, res) => {
    const { planId, mealType, meal } = req.body;
    if (!planId || !mealType || !meal) return res.status(400).json({ error: 'planId, mealType, and meal required' });

    const plan = queryOne('SELECT * FROM meal_plans WHERE id = ?', [planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [plan.user_id, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Plan not found' });

    // Check cache
    const cached = queryOne('SELECT * FROM meal_details WHERE plan_id = ? AND meal_type = ?', [planId, mealType]);
    if (cached) {
      return res.json({
        recipe: JSON.parse(cached.recipe_json),
        cookware: JSON.parse(cached.cookware_json),
        why: cached.why_text,
        cached: true,
      });
    }
    if (!AI_KEY) return sendAiConfigError(res);

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

      const completion = await getAiClient().chat.completions.create({
        model: process.env.AI_MODEL || 'local',
        messages: [
          { role: 'system', content: 'Output directly. No reasoning. No thinking. Just respond with the JSON immediately.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
        chat_template_kwargs: { enable_thinking: false },
      }, { signal: controller.signal });
      clearTimeout(timeoutId);

      const raw = (completion.choices[0].message.content || '').trim();
      if (!raw) throw new Error('AI returned empty content');

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

      runDb(
        'INSERT OR REPLACE INTO meal_details (plan_id, meal_type, recipe_json, cookware_json, why_text) VALUES (?, ?, ?, ?, ?)',
        [planId, mealType, JSON.stringify(recipe), JSON.stringify(cookware), why]
      );

      res.json({ recipe, cookware, why, cached: false });
    } catch (err) {
      console.error(`[AI] meal-detail error: ${err.message}`);
      if (isAiConfigError(err)) return sendAiConfigError(res);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
