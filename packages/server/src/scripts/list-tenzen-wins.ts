/**
 * Print N most recent completed games where tenzen won, one UUID per line.
 * Used by fork-demos-parallel.sh to enumerate the demo set.
 *
 * Usage: pnpm tsx packages/server/src/scripts/list-tenzen-wins.ts [N]
 */

import { db } from '../db/client.js';
import { games } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import type { GameState } from '@ruin/engine';

const N = parseInt(process.argv[2] ?? '10', 10);

(async () => {
  const rows = await db.select({ id: games.id, state: games.state })
    .from(games).where(eq(games.isComplete, true))
    .orderBy(desc(games.updatedAt)).limit(50);
  const ids: string[] = [];
  for (const r of rows) {
    const s = r.state as GameState;
    if (s.winners?.includes('tenzen')) {
      ids.push(r.id);
      if (ids.length >= N) break;
    }
  }
  for (const id of ids) console.log(id);
  process.exit(0);
})();
