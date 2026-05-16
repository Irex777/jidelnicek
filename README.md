# Jídelníček

AI meal-planning app with Express, static frontend assets, sql.js SQLite storage, authentication, shopping lists, and optional AI generation.

## Run

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

Open http://localhost:3000.

The app now starts without an AI key, so auth, profiles, existing plans, and shopping-list flows still work locally. AI endpoints return HTTP 503 until `ZAI_API_KEY` is configured.

To enable AI generation:

```bash
ZAI_API_KEY=your_key npm start
```

## Configuration

Copy `.env.example` to `.env` if you use a process manager or shell helper that loads env files.

Available variables:

- `PORT`: HTTP port. Default: `3000`.
- `ZAI_API_KEY`: API key for AI generation and chat. Optional for non-AI local use.
- `AI_BASE_URL`: OpenAI-compatible API base URL. Default: `https://api.z.ai/api/coding/paas/v4`.
- `AI_MODEL`: model name. Default: `glm-5-turbo`.
- `AI_MAX_TOKENS`: day-plan max token budget. Default: `3000`.
- `AI_TIMEOUT`: day-plan timeout in milliseconds. Default: `45000`.
- `DATA_DIR`: directory for the sql.js database. Default: `./data`.
- `APP_VERSION`: optional fixed cache-busting version. Defaults to a fresh runtime value.

## Test

```bash
npm test
```

The tests use a temporary database and do not require an AI key.
