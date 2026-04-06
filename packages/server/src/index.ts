import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { ensureSchema } from './db/migrate.js';
import authRouter from './routes/auth.js';
import gamesRouter from './routes/games.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

async function main() {
  // ── Database ───────────────────────────────────────────────────────────────
  await ensureSchema();

  // ── Express app ───────────────────────────────────────────────────────────
  const app = express();

  app.use(
    cors({
      origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
      credentials: true,
    }),
  );

  app.use(express.json());

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use('/api/auth', authRouter);
  app.use('/api/games', gamesRouter);

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── Serve React client (production) ────────────────────────────────────────
  if (process.env['NODE_ENV'] === 'production') {
    app.use(express.static(CLIENT_DIST));

    // Fallback: send index.html for any non-API route (client-side routing)
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Ruin server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
