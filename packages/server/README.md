# @ruin/server

Express + PostgreSQL backend for Ruin. Authentication, game state persistence, real-time SSE streaming, AI turn execution, and the self-play training scripts.

## Stack

- Express (routes, middleware)
- Drizzle ORM + PostgreSQL
- JWT auth (7-day tokens, bcrypt for passwords, magic-link email login)
- Server-Sent Events for live game updates
- Node `worker_threads` for off-loop MCTS execution
- Nodemailer (AWS SES in prod, console output in dev)

## Layout

```
src/
├── index.ts          Express app + boot
├── routes/
│   ├── auth.ts       /api/auth — register, login, magic links
│   └── games.ts      /api/games — list, create, state, action, stream, chat
├── db/               Drizzle schema and migrations
├── auth/             JWT, bcrypt, magic-link helpers
├── middleware/       requireAuth + optionalAuth (Bearer or ?token=)
├── email/            Nodemailer transports + templates
├── game/
│   ├── service.ts    createGame, applyPlayerAction, maybeRunAiTurns, getGameState
│   └── sse.ts        in-memory broadcast registry
├── workers/
│   └── mctsWorker.ts worker thread entry — runs runMcts and posts back
└── scripts/          self-play and benchmark CLIs (see below)
```

## Action flow

```
client
  → POST /api/games/:id/action  (Zod-validated)
  → requireAuth
  → game/service.applyPlayerAction
      → load state from DB
      → engine.applyAction(state, action)
      → save new state + log
  → game/sse.broadcast(gameId, ...)
  → maybeRunAiTurns(state)            ← loops while pendingAction.waitingFor is AI
      ↳ summoning_action → workers/mctsWorker (worker thread)
      ↳ everything else  → greedyAction (inline)
```

AI turns run synchronously after each human action so clients see them as they happen.

## SSE

`GET /api/games/:id/stream` accepts a `?token=` query param (because `EventSource` can't set headers). On connect, server sends an immediate `history` frame with state + log + chat, then streams subsequent updates as `state` / `log` / `chat` frames. Pings every 30s.

## Scripts

Run from the repo root via `pnpm <script>`:

| Script | Purpose |
|---|---|
| `pnpm headless` | One verbose AI-vs-AI game (debugging) |
| `pnpm benchmark` | N games single-process, prints win rates / DAC / VP stats |
| `pnpm benchmark:parallel` | Same, sharded across worker processes |
| `pnpm collect` | Self-play data collection (writes JSONL features + visits) |
| `pnpm collect:parallel` | Same, sharded |
| `pnpm duel` | Compare two models head-to-head |

`scripts/training-loop.sh` (repo root) orchestrates the full self-play loop: collect → train → snapshot → bench every N iterations.

The benchmark script accepts `--model packages/ai/data/model_iter_NNNN.json` so you can replay any historical snapshot without touching `model.json`.

## Local dev

See the top-level `README.md` for environment setup. To run just this package:

```bash
pnpm --filter server dev
```

Hot reload via `tsx watch`. Listens on `:3001` by default.

## Tests

Engine has the bulk of the tests. Server has minimal coverage; most behavior is exercised through the headless and benchmark scripts.
