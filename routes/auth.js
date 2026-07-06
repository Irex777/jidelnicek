// ═══════════════════════════════════════════════════════════════════════
// Auth routes — register, login, logout, me
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { queryOne, runDb } = require('../db');

const AUTH_EXEMPT_ROUTES = ['/auth/register', '/auth/login', '/health'];

function authMiddleware(req, res, next) {
  if (AUTH_EXEMPT_ROUTES.some(r => req.path === r)) return next();

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Přihlášení vyžadováno' });

  const session = queryOne(
    'SELECT s.*, a.email, a.name as account_name FROM sessions s JOIN accounts a ON s.account_id = a.id WHERE s.token = ?',
    [token]
  );
  if (!session) return res.status(401).json({ error: 'Neplatná relace' });

  const now = new Date().toISOString();
  if (session.expires_at < now) {
    runDb('DELETE FROM sessions WHERE token = ?', [token]);
    return res.status(401).json({ error: 'Relace vypršela' });
  }

  req.account = { id: session.account_id, email: session.email, name: session.account_name };
  next();
}

function createToken(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  runDb('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)', [token, accountId, expiresAt]);
  return token;
}

function register(app) {
  // Apply middleware to all /api/* routes
  app.use('/api', authMiddleware);

  // ── Register ──
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Vyplňte všechny údaje' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Heslo musí mít alespoň 6 znaků' });
    }

    const existing = queryOne('SELECT id FROM accounts WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) {
      return res.status(400).json({ error: 'Tento e-mail je již zaregistrován' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const accountId = runDb(
        'INSERT INTO accounts (email, password_hash, name) VALUES (?, ?, ?)',
        [email.toLowerCase().trim(), passwordHash, name.trim()]
      );
      const token = createToken(accountId);
      res.json({ token, account: { id: accountId, email: email.toLowerCase().trim(), name: name.trim() } });
    } catch (err) {
      console.error('[AUTH] Register error:', err.message);
      res.status(500).json({ error: 'Chyba při registraci' });
    }
  });

  // ── Login ──
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Vyplňte e-mail a heslo' });
    }

    const account = queryOne('SELECT * FROM accounts WHERE email = ?', [email.toLowerCase().trim()]);
    if (!account) {
      return res.status(401).json({ error: 'Neplatný e-mail nebo heslo' });
    }

    try {
      const valid = await bcrypt.compare(password, account.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Neplatný e-mail nebo heslo' });
      }
      const token = createToken(account.id);
      res.json({ token, account: { id: account.id, email: account.email, name: account.name } });
    } catch (err) {
      console.error('[AUTH] Login error:', err.message);
      res.status(500).json({ error: 'Chyba při přihlášení' });
    }
  });

  // ── Logout ──
  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      runDb('DELETE FROM sessions WHERE token = ?', [token]);
    }
    res.json({ ok: true });
  });

  // ── Me ──
  app.get('/api/auth/me', (req, res) => {
    res.json({ account: req.account });
  });
}

module.exports = { register, authMiddleware };
