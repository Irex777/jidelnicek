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

The app starts without an AI key, so auth, profiles, existing plans, and shopping-list flows still work locally. AI endpoints return HTTP 503 until `AI_API_KEY` is configured.

To enable AI generation, point the app at any OpenAI-compatible endpoint (e.g. `llama-server`):

```bash
AI_API_KEY=local AI_BASE_URL=http://localhost:8080/v1 npm start
```

## Configuration

`npm start` loads `.env` automatically (Node `--env-file`). Copy `.env.example` to `.env` and edit.

Available variables:

- `PORT`: HTTP port. Default: `3000`.
- `AI_API_KEY`: API key for the OpenAI-compatible endpoint. Any non-empty string for local `llama-server`. Required for AI features.
- `AI_BASE_URL`: OpenAI-compatible API base URL. Default: `http://localhost:8080/v1` (`llama-server`).
- `AI_MODEL`: model name. Default: `local`. `llama-server` accepts any string.
- `AI_MAX_TOKENS`: day-plan max token budget. Default: `4000`.
- `AI_TIMEOUT`: day-plan timeout in milliseconds. Default: `180000` (local inference is slower than cloud).
- `DATA_DIR`: directory for the sql.js database. Default: `./data`.
- `APP_VERSION`: optional fixed cache-busting version. Defaults to a fresh runtime value.

## Test

```bash
npm test
```

The tests use a temporary database and do not require an AI key.
