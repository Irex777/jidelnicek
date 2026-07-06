// ═══════════════════════════════════════════════════════════════════════
// AI — OpenAI-compatible client & day plan generation
// ═══════════════════════════════════════════════════════════════════════

const OpenAI = require('openai');
const { DAY_NAMES_CS, getDayIndex } = require('../utils');

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8080/v1';
const AI_MODEL = process.env.AI_MODEL || 'local';
const AI_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS) || 4000;
const AI_TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 180000;
const AI_KEY = process.env.AI_API_KEY || '';

let ai = null;

class AiConfigError extends Error {
  constructor() {
    super('AI není nakonfigurovaná. Nastavte AI_API_KEY pro generování jídelníčků a chat.');
    this.name = 'AiConfigError';
    this.status = 503;
  }
}

function getAiClient() {
  if (!AI_KEY) throw new AiConfigError();
  if (!ai) ai = new OpenAI({ apiKey: AI_KEY, baseURL: AI_BASE_URL });
  return ai;
}

function isAiConfigError(err) {
  return err instanceof AiConfigError || err?.status === 503 || err?.code === 'AI_NOT_CONFIGURED';
}

// ── Day Plan Generation ──────────────────────────────────────────────
async function generateDayPlan(user, date, previousMealNames) {
  const dayIdx = getDayIndex(date);
  const dayName = DAY_NAMES_CS[dayIdx];
  const targetCal = user.calories_target || 2000;
  const t0 = Date.now();

  const antiRepeat = previousMealNames.length > 0
    ? `\nNEOPAKUJ: ${previousMealNames.slice(-15).join(', ')}` : '';

  const sex = user.sex === 'male' ? 'muž' : user.sex === 'female' ? 'žena' : '?';
  const prompt = `${dayName}, ${user.name}, ${sex}, ${user.age||'?'}let, ${user.weight_current||'?'}→${user.weight_goal||'?'}kg, ${user.activity_level||'moderate'}, diety:${user.dietary_restrictions||'žádné'}${user.allergies ? ', alergie:'+user.allergies : ''}. Cíl:${targetCal}kcal.${antiRepeat}
JSON: {"day":"${dayName}","total_calories":N,"total_protein":N,"total_carbs":N,"total_fat":N,"meals":{"breakfast":{"name":"","calories":N,"protein":N,"carbs":N,"fat":N,"ingredients":["100g ..."],"prep_time":"N min"},"morning_snack":{...},"lunch":{...},"afternoon_snack":{...},"dinner":{...}}}
České suroviny, 30P/40C/30F, max 30min. Pouze JSON.`;

  const messages = [
    { role: 'system', content: 'Jsi výživový poradce. Vrať POUZE JSON jídelníček pro 1 den. Žádný markdown, žádný komentář.' },
    { role: 'user', content: prompt },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT);

  try {
    const completion = await getAiClient().chat.completions.create(
      { model: AI_MODEL, messages, temperature: 0.7, max_tokens: AI_MAX_TOKENS, chat_template_kwargs: { enable_thinking: false } },
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    const raw = (completion.choices[0].message.content || '').trim();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!raw) {
      throw new Error(`Empty response after ${elapsed}s — model may have used all tokens on reasoning`);
    }
    console.log(`[AI] ${dayName}: ${raw.length} chars in ${elapsed}s`);
    return parseDayPlan(raw);
  } catch (err) {
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[AI] ${dayName} failed after ${elapsed}s: ${err.message}`);
    throw err;
  }
}

function parseDayPlan(raw) {
  let content = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Extract outermost JSON object
  const jsonStart = content.indexOf('{');
  if (jsonStart > 0) content = content.substring(jsonStart);
  const jsonEnd = content.lastIndexOf('}');
  if (jsonEnd > jsonStart) content = content.substring(0, jsonEnd + 1);

  try { return JSON.parse(content); } catch (e1) {
    // Repair truncated JSON: strip incomplete trailing key/value pairs
    let fixed = content
      .replace(/,\s*"[^"]*"\s*:\s*("[^"]*$|[0-9]*$)/, '')   // incomplete value
      .replace(/,\s*"[^"]*"\s*:\s*$/, '')                      // incomplete key
      .replace(/,\s*"[^"]*":\s*\[?\s*$/, '')                   // incomplete array/object
      .replace(/,\s*$/, '');                                    // trailing comma

    try { return JSON.parse(fixed); } catch (e2) {
      // Last resort: scan for known top-level keys and extract valid object
      const dayMatch = fixed.match(/\{"day"[^}]*\}/s);
      if (dayMatch) {
        try { return JSON.parse(dayMatch[0]); } catch {}
      }
      throw new Error(`Failed to parse AI response: ${e1.message} (repair: ${e2.message})`);
    }
  }
}

function extractMealNames(planData) {
  if (!planData || !planData.meals) return [];
  return Object.values(planData.meals).map(m => m.name).filter(Boolean);
}

module.exports = {
  AI_MODEL, AI_KEY, AI_BASE_URL, AI_MAX_TOKENS, AI_TIMEOUT,
  AiConfigError,
  getAiClient,
  isAiConfigError,
  generateDayPlan,
  parseDayPlan,
  extractMealNames,
};
