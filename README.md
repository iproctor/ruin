# Ruin: Gods of Chaos

A turn-based multiplayer strategy game. This is a pnpm monorepo with four packages:

- **`packages/engine`** — Pure TypeScript game logic (immutable state, legal action checking, victory)
- **`packages/ai`** — MCTS AI player
- **`packages/client`** — React + Vite frontend
- **`packages/server`** — Express API + PostgreSQL + SSE

---

## Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- PostgreSQL 14+

---

## Local development

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Create `packages/server/.env`:

```env
DATABASE_URL=postgres://localhost:5432/ruin
JWT_SECRET=some-random-secret
PORT=3001
CORS_ORIGIN=http://localhost:5173
APP_URL=http://localhost:5173
```

### 3. Create the database

```bash
createdb ruin
```

The server runs migrations automatically on startup — no separate migration step needed.

### 4. Start the server

```bash
pnpm --filter server dev
```

Starts Express on [http://localhost:3001](http://localhost:3001) with hot reload via `tsx watch`.

### 5. Start the client

In a second terminal:

```bash
pnpm --filter client dev
```

Opens the Vite dev server at [http://localhost:5173](http://localhost:5173). API calls are proxied to port 3001.

---

## Running tests

```bash
pnpm --filter engine test
```

Engine tests use Jest with `ts-jest`.

---

## Production build

Build all packages in dependency order:

```bash
pnpm build
```

This runs `tsc` / `vite build` across `engine → ai → client → server`. The server then serves the compiled client from `packages/client/dist`.

Start in production mode:

```bash
cd packages/server && node dist/index.js
```

### Docker

```bash
docker build -t ruin .
docker run -e DATABASE_URL=postgres://... -e JWT_SECRET=... -p 3001:3001 ruin
```

---

## Environment variables

All for `packages/server/.env`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `JWT_SECRET` | *(required)* | Secret for signing JWTs |
| `PORT` | `3001` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `APP_URL` | `http://localhost:5173` | Used in email links |
| `EMAIL_FROM` | `noreply@ruin.game` | Sender address |
| `AWS_REGION` | `us-east-1` | For SES email in production |
| `AWS_ACCESS_KEY_ID` | | For SES email in production |
| `AWS_SECRET_ACCESS_KEY` | | For SES email in production |

In development, emails are printed to the console instead of sent.

---

## Architecture notes

- **Game state** is a plain JSON object. `applyAction(state, action)` returns a new state + log entries; it never mutates.
- **AI turns** run in a Node.js worker thread (via `worker_threads`) so they don't block the event loop.
- **Real-time updates** use Server-Sent Events (`/api/games/:id/stream`). The token is passed as a `?token=` query parameter since `EventSource` can't set headers.
- **Drag and drop** uses `@dnd-kit/core`. Drop zones are HTML divs positioned over the SVG board, with `pointerEvents: none` unless a drag is active.
- **Client-side action buffering** — during the summoning phase, drag actions build a `pendingAction` preview rendered locally via `applyAction`. End Turn commits it to the server, Undo clears it.

---

## Package scripts

| Command | What it does |
|---|---|
| `pnpm --filter server dev` | Server with hot reload |
| `pnpm --filter client dev` | Vite dev server |
| `pnpm --filter engine test` | Run engine unit tests |
| `pnpm build` | Build everything for production |
| `pnpm --filter infra cdk deploy` | Deploy AWS infrastructure |
