const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jidelnicek-test-'));
process.env.APP_VERSION = 'test-version';
delete process.env.AI_API_KEY;

const { startServer, _test } = require('../server');

let server;
let base;

test.before(async () => {
  server = await startServer(0, '127.0.0.1');
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  const res = await fetch(base + pathname, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function createAccountAndProfile() {
  const email = `test-${Date.now()}-${Math.random()}@example.com`;
  const registered = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Account', email, password: 'secret123' }),
  });
  assert.equal(registered.res.status, 200);
  assert.ok(registered.body.token);

  const created = await request('/api/users', {
    method: 'POST',
    headers: authHeaders(registered.body.token),
    body: JSON.stringify({
      name: 'Profile One',
      sex: 'female',
      age: 32,
      weight_current: 72,
      weight_goal: 68,
      height: 168,
      activity_level: 'moderate',
      dietary_restrictions: '',
      allergies: '',
      favorite_foods: '',
    }),
  });
  assert.equal(created.res.status, 200);
  assert.ok(created.body.id);

  return { token: registered.body.token, user: created.body };
}

test('starts without AI key and reports AI-disabled health', async () => {
  const health = await request('/api/health');
  assert.equal(health.res.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.ai_configured, false);

  const index = await request('/');
  assert.equal(index.res.status, 200);
  assert.match(index.body, /app\.js\?v=test-version/);
  assert.match(index.body, /style\.css\?v=test-version/);
});

test('protects API routes and supports auth/profile lifecycle', async () => {
  const unauthorized = await request('/api/users');
  assert.equal(unauthorized.res.status, 401);

  const { token, user } = await createAccountAndProfile();

  const me = await request('/api/auth/me', { headers: authHeaders(token) });
  assert.equal(me.res.status, 200);
  assert.equal(me.body.account.name, 'Test Account');

  const listed = await request('/api/users', { headers: authHeaders(token) });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, user.id);

  const updated = await request(`/api/users/${user.id}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ ...user, name: 'Updated Profile', activity_level: 'light' }),
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.body.name, 'Updated Profile');

  const loggedOut = await request('/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(loggedOut.res.status, 200);
  assert.equal(loggedOut.body.ok, true);

  const afterLogout = await request('/api/users', { headers: authHeaders(token) });
  assert.equal(afterLogout.res.status, 401);
});

test('AI endpoints return friendly 503 when key is missing', async () => {
  const { token, user } = await createAccountAndProfile();

  const generated = await request('/api/generate-day', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId: user.id, date: '2026-05-11' }),
  });
  assert.equal(generated.res.status, 503);
  assert.equal(generated.body.code, 'AI_NOT_CONFIGURED');

  const week = await request('/api/generate-week-async', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId: user.id, weekStart: '2026-05-11' }),
  });
  assert.equal(week.res.status, 503);
  assert.equal(week.body.code, 'AI_NOT_CONFIGURED');

  const chat = await request('/api/chat', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId: user.id, message: 'hello' }),
  });
  assert.equal(chat.res.status, 503);
  assert.equal(chat.body.code, 'AI_NOT_CONFIGURED');
});

test('shopping list cache is invalidated when a plan changes', async () => {
  const { token, user } = await createAccountAndProfile();
  const date = '2026-05-11';
  const from = '2026-05-11';
  const to = '2026-05-17';
  const meals = {
    breakfast: {
      name: 'Oats',
      calories: 400,
      protein: 20,
      carbs: 50,
      fat: 10,
      ingredients: ['100 g oats'],
      prep_time: '5 min',
    },
  };

  const planId = _test.runDb(
    'INSERT INTO meal_plans (user_id, date, day_name, total_calories, total_protein, total_carbs, total_fat, meals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, date, 'Monday', 400, 20, 50, 10, JSON.stringify(meals)]
  );

  const firstList = await request(`/api/shopping-list/${user.id}?from=${from}&to=${to}`, {
    headers: authHeaders(token),
  });
  assert.equal(firstList.res.status, 200);
  assert.match(firstList.body.items.map(i => i.display).join(' '), /oats/i);

  const changedMeals = {
    breakfast: {
      name: 'Rice bowl',
      calories: 430,
      protein: 18,
      carbs: 70,
      fat: 8,
      ingredients: ['200 g rice'],
      prep_time: '15 min',
    },
  };

  const updatedPlan = await request(`/api/plan/${planId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ day_name: 'Monday', meals: changedMeals }),
  });
  assert.equal(updatedPlan.res.status, 200);

  const secondList = await request(`/api/shopping-list/${user.id}?from=${from}&to=${to}`, {
    headers: authHeaders(token),
  });
  assert.equal(secondList.res.status, 200);
  const display = secondList.body.items.map(i => i.display).join(' ');
  assert.match(display, /rice/i);
  assert.doesNotMatch(display, /oats/i);
});
