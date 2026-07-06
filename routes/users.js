// ═══════════════════════════════════════════════════════════════════════
// User profile routes — CRUD
// ═══════════════════════════════════════════════════════════════════════

const { queryAll, queryOne, runDb } = require('../db');
const { calcCaloriesTarget } = require('../utils');

function register(app) {
  // ── List profiles ──
  app.get('/api/users', (req, res) => {
    res.json(queryAll('SELECT * FROM users WHERE account_id = ? ORDER BY id', [req.account.id]));
  });

  // ── Create profile ──
  app.post('/api/users', (req, res) => {
    const d = req.body;
    if (!d.name) return res.status(400).json({ error: 'Name is required' });

    const tempUser = { ...d, activity_level: d.activity_level || 'moderate' };
    const calories_target = calcCaloriesTarget(tempUser);
    const newUserId = runDb(
      `INSERT INTO users (name, sex, age, weight_current, weight_goal, height, activity_level, dietary_restrictions, allergies, favorite_foods, calories_target, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.name, d.sex || null, d.age || null,
       d.weight_current || null, d.weight_goal || null, d.height || null,
       d.activity_level || 'moderate', d.dietary_restrictions || '',
       d.allergies || '', d.favorite_foods || '', calories_target, req.account.id]
    );
    const user = queryOne('SELECT * FROM users WHERE id = ?', [newUserId]);
    res.json(user);
  });

  // ── Update profile ──
  app.put('/api/users/:id', (req, res) => {
    const d = req.body;
    const id = parseInt(req.params.id);
    const existing = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [id, req.account.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

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

  // ── Delete profile ──
  app.delete('/api/users/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = queryOne('SELECT * FROM users WHERE id = ? AND account_id = ?', [id, req.account.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    runDb('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  });
}

module.exports = { register };
