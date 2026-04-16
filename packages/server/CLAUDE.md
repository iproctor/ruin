# Server — notes for Claude

Express + Drizzle + SSE + AI worker threads. The wiring is intentionally simple: no job queue, no Redis, no Kafka. AI turns run synchronously after human moves.

## Invariants — do not violate

- **Engine purity boundary.** All game-rule logic lives in `@ruin/engine`. The server's job is persistence + transport + auth. Don't reimplement engine logic here, and don't add server-only mutations to game state.
- **Hand masking.** State sent to a client over SSE or `GET /api/games/:id` must be masked via `maskStateForViewer(state, viewerUserId, players)` so other players' hands and deck contents stay hidden. Forget this and you leak hidden info.
- **Action validation.** Every action body is parsed by a Zod schema in `routes/games.ts`. When you add an Action to `@ruin/engine`, you MUST add a matching schema variant here, otherwise the wire will reject it.
- **AI turns must save + broadcast per step.** `maybeRunAiTurns` saves state and calls `broadcast` after every AI move so clients see them in real time. Don't batch them up.
- **Worker threads are short-lived.** `mctsWorker.ts` runs one MCTS call and exits. There's no persistent pool. Adding pooling is fine but watch memory — each worker loads the model.
- **`optionalAuth` exists for SSE only.** It accepts `?token=` because `EventSource` can't set Authorization headers. Don't use it for state-mutating routes.

## Common pitfalls

- **Adding a route that mutates state.** Make sure it (a) loads the latest state from DB inside the request handler, (b) calls `engine.applyAction`, (c) persists the result, (d) broadcasts via SSE, (e) calls `maybeRunAiTurns` if a follow-up AI turn is queued. Skipping any of those produces stale clients or stuck games.
- **SSE listeners are in-memory.** A server restart drops every connected stream. Clients reconnect automatically. If you scale to multiple server instances, you'll need sticky sessions or a pub/sub layer.
- **DB writes are not transactional across action + log.** A crash between `saveState` and `appendLog` leaves a desynced state. If this becomes a real problem, wrap them in a Drizzle transaction.
- **Invitations target usernames only.** Invited users who are online get an SSE `invited` event; offline users with an email address get an email linking to `/lobby/g/:gameId`. If they have no email, the invitation is still recorded — they'll see it next time they're online.
- **Email transport diverges by env.** Dev uses console JSON output, prod uses AWS SES. If you add a new template, test both paths.

## Scripts directory

The scripts under `src/scripts/` are CLI tools, not part of the server runtime. They share helpers (like `load-model.ts`) but each is a standalone `tsx` entry point.

- `collect-data.ts` and `benchmark.ts` accept a `--model <path>` flag (added recently) so you can run them against any historical model snapshot without touching `packages/ai/data/model.json`.
- `collect-parallel.ts` and `benchmark-parallel.ts` shard the work across child processes and aggregate per-worker results.
- `training-loop.sh` (in the repo root, not here) is the orchestrator for self-play: collect → train → snapshot → optionally bench.

When debugging a training-iteration issue, the fastest signal is usually `pnpm benchmark --games 1 --seed N --model packages/ai/data/model_iter_NNNN.json`.

## Don't add to this package

- Game-rule logic — belongs in `@ruin/engine`
- AI search/learning code — belongs in `@ruin/ai`
- React or browser code — belongs in `@ruin/client`
- Long-running background jobs — there's no scheduler. If you really need one, use a separate process and a DB-backed queue table.
