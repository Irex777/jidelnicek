// ═══════════════════════════════════════════════════════════════════════
// Chat routes — history + SSE streaming AI responses
// ═══════════════════════════════════════════════════════════════════════

const { queryAll, queryOne, runDb } = require('../db');
const { AI_KEY, getAiClient, AiConfigError } = require('../ai');

function sendAiConfigError(res) {
  return res.status(503).json({ error: new AiConfigError().message, code: 'AI_NOT_CONFIGURED' });
}

function register(app) {
  // ── Chat history ──
  app.get('/api/chat/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const profile = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!profile) return res.status(404).json({ error: 'Profil nenalezen' });

    const rows = queryAll('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]);
    res.json(rows.reverse());
  });

  // ── Chat (SSE streaming) ──
  app.post('/api/chat', async (req, res) => {
    const { userId, message, planDate } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'userId and message required' });
    if (!AI_KEY) return sendAiConfigError(res);

    const user = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [userId, req.account.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    runDb('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)', [userId, 'user', message]);

    const history = queryAll('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [userId]).slice(0, 20).reverse();

    let planContext = '';
    if (planDate) {
      const plan = queryOne('SELECT * FROM meal_plans WHERE user_id = ? AND date = ?', [userId, planDate]);
      if (plan) planContext = `\nAktuální plán pro ${planDate}:\n${plan.meals_json}`;
    }

    const systemMsg = `Jsi výživový poradce pro ${user.name}. Cíl: ${user.calories_target || 2000}kcal. Diety: ${user.dietary_restrictions || 'žádné'}.
${planContext}
Odpovídej v češtině. Pokud uživatel žádá změnu jídelníčku, navrhni konkrétní změny.`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const stream = await getAiClient().chat.completions.create({
        model: process.env.AI_MODEL || 'local',
        messages: [
          { role: 'system', content: systemMsg },
          ...history.map(m => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.7,
        max_tokens: 2000,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          res.write(`data: ${JSON.stringify({ type: 'token', content: delta })}\n\n`);
        }
      }

      runDb('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)', [userId, 'assistant', fullContent]);
      res.write(`data: ${JSON.stringify({ type: 'done', message: fullContent })}\n\n`);
      res.end();
    } catch (err) {
      console.error(`[AI] Chat error: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  });
}

module.exports = { register };
