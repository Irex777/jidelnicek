// ═══════════════════════════════════════════════════════════════════════
// Jídelníček v3 — Entry point
// ═══════════════════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fs = require('fs');

const { initDb } = require('./db');
const { AI_MODEL, AI_KEY } = require('./ai');

// ── AI config log ────────────────────────────────────────────────────
console.log(`[AI] model=${AI_MODEL} configured=${AI_KEY ? 'yes' : 'no'}`);

// ── App setup ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));

let APP_VERSION = process.env.APP_VERSION || Date.now().toString(36);

// Version route (registered before static)
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.json({ version: APP_VERSION });
});

// Static assets with no-cache headers for critical files
const NO_CACHE_FILES = ['app.js', 'style.css', 'index.html', 'sw.js'];
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (NO_CACHE_FILES.some(f => filePath.endsWith(f))) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve index.html with version-injected asset tags
let indexHtmlCache = null;
let indexHtmlVersion = null;

function getIndexHtml() {
  if (indexHtmlCache && indexHtmlVersion === APP_VERSION) return indexHtmlCache;
  const raw = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  indexHtmlCache = raw
    .replace(/src="app\.js"/, `src="app.js?v=${APP_VERSION}"`)
    .replace(/href="style\.css"/, `href="style.css?v=${APP_VERSION}"`);
  indexHtmlVersion = APP_VERSION;
  return indexHtmlCache;
}

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'text/html');
  res.send(getIndexHtml());
});

// ── Health (before auth middleware) ──────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', model: AI_MODEL, ai_configured: Boolean(AI_KEY), db: 'sqlite-wasm' });
});

// ── Register route modules ───────────────────────────────────────────
require('./routes/auth').register(app);
require('./routes/users').register(app);
require('./routes/plans').register(app);
require('./routes/chat').register(app);
require('./routes/shopping').register(app);
require('./routes/details').register(app);

// ── SPA fallback ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'text/html');
  res.send(getIndexHtml());
});

// ── Start ────────────────────────────────────────────────────────────
const parsedPort = process.env.PORT === undefined ? 3000 : parseInt(process.env.PORT, 10);
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;

async function startServer(port = PORT, host = '0.0.0.0') {
  await initDb();
  const server = app.listen(port, host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const shownPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Jídelníček v3 running on :${shownPort} (SQLite/sql.js WASM, day-by-day, parallel week)`);
  return server;
}

async function main() {
  const server = await startServer();
  app.locals.server = server;
}

if (require.main === module) {
  main().catch(err => { console.error('Startup failed:', err); process.exit(1); });
}

process.on('uncaughtException', err => console.error('Uncaught:', err.message));

module.exports = { app, startServer, initDb, _test: require('./db') };
