# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**Jídelníček v3** — a full-stack AI meal-planning app (Czech language) with Express, static frontend assets, sql.js (WASM SQLite) storage, authentication, shopping lists, and optional AI meal-plan generation via an OpenAI-compatible API.

Single-file monolith: **`server.js`** (~1330 lines) contains the entire backend. Frontend lives in **`public/`** (vanilla JS SPA, no build step).

## Commands

```bash
npm install          # install dependencies
npm start            # production start (port 3000)
npm test             # run API tests (Node --test, no AI key needed)
node --test test/app.test.js   # run single test file
```

Tests use a temporary database and no AI key — they verify auth, health, profile CRUD, shopping-list invalidation, and that AI endpoints return 503 when unconfigured.

## Architecture

### Database Schema (sql.js WASM SQLite)

- **accounts** — auth identities (email, bcrypt password hash)
- **sessions** — bearer-token sessions (30-day expiry)
- **users** — meal-plan profiles per account (one account → many profiles) with BMR/TDEE fields
- **meal_plans** — one row per user per day (`meals_json` stores the full day: breakfast, morning_snack, lunch, afternoon_snack, dinner with macros + ingredients)
- **meal_details** — cached AI-generated recipe steps + cookware per plan+meal_type
- **shopping_lists** — cached aggregated ingredient lists for date ranges
- **chat_messages** — conversation history per user

### Auth Flow

1. Register/Login → bcrypt hash → creates account + session token → returns `Bearer` token
2. Token stored in `localStorage` on client, sent as `Authorization: Bearer <token>`
3. `authMiddleware` (applied to all `/api/*` routes) validates token, checks expiry, attaches `req.account`
4. Exempt routes: `/auth/register`, `/auth/login`, `/health` — use **mount-relative paths** (no `/api/` prefix) since the middleware is mounted on `/api`

### API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/health` | Health check, reports AI configured status |
| POST | `/api/auth/register` | Create account + session |
| POST | `/api/auth/login` | Login → session token |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current account info |
| CRUD | `/api/users` | Profile management (scoped to account) |
| GET | `/api/plan/:userId` | Fetch meal plans (optional `?from=&to=`) |
| PUT | `/api/plan/:planId` | Edit a plan (invalidates shopping list cache) |
| DELETE | `/api/plan/:planId` | Delete a plan |
| POST | `/api/generate-day` | Generate a single day plan via AI |
| POST | `/api/generate-week` | SSE streaming week generation (7 days in parallel) |
| POST | `/api/generate-week-async` | Fire-and-forget week generation |
| GET | `/api/generate-status/:userId?weekStart=` | Poll background generation status |
| GET/POST | `/api/chat/:userId` | AI nutrition chat (SSE streaming for responses) |
| POST | `/api/meal-detail` | On-demand AI recipe detail (cached in `meal_details`) |
| GET | `/api/shopping-list/:userId?from=&to=` | Aggregated shopping list with ingredient merging |

### AI Generation

- Uses OpenAI-compatible client (`openai` package) with configurable `AI_API_KEY` + `AI_BASE_URL`
- Day plans generated in **parallel** (all 7 days fire simultaneously, each ~45s timeout)
- Anti-repetition: last 4 days of meal names passed as context to avoid repeats
- Response parsing: `parseDayPlan()` strips markdown fences, repairs truncated JSON (bracket balancing)
- Without `AI_API_KEY`, app runs fine — AI endpoints return 503 with `AI_NOT_CONFIGURED` code

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP listen port |
| `AI_API_KEY` | — | AI API key (any non-empty value for local `llama-server`) |
| `AI_BASE_URL` | `http://localhost:8080/v1` | OpenAI-compatible endpoint |
| `AI_MODEL` | `local` | Model name |
| `AI_MAX_TOKENS` | `3000` | Token budget per day plan |
| `AI_TIMEOUT` | `45000` | Millisecond timeout per day plan |
| `DATA_DIR` | `./data` | Directory for SQLite file |
| `APP_VERSION` | runtime-generated | Cache-busting version hash |

### Cache Invalidation

- Updating or deleting a `meal_plan` → deletes `meal_details` for that plan + all `shopping_lists` for that user
- `runDb()` calls `saveDb()` (writes DB to disk) after every mutation

### Frontend

- `public/index.html` — served with version-injected script/css tags and no-cache headers
- `public/app.js` — vanilla JS SPA (~43 KB), no build step
- `public/sw.js` — service worker for offline support
- Critical assets (`app.js`, `style.css`, `index.html`, `sw.js`) served with `Cache-Control: no-store`

### Test Access Pattern

Tests import `startServer()` (starts on ephemeral port) and `_test` exports (`queryAll`, `queryOne`, `runDb`) for direct DB manipulation in tests.
