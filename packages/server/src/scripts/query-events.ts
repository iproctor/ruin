import { db } from '../db/client.js';
import { gameEvents } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';

const gameId = process.argv[2] ?? '1161bcd5-4ab6-4cfb-9ec3-f4e3c3ea3e55';

async function main() {
  const rows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(gameEvents.seq));

  for (const r of rows) {
    const ev = r.event as any;
    let extra = '';
    if (ev.type === 'phase_start') extra = ` phase=${ev.phase} round=${ev.round}`;
    else if (ev.type === 'round_start') extra = ` round=${ev.round}`;
    else if (ev.type === 'power_draw') extra = ` power=${ev.power} drawn=${ev.drawn} handSize=${ev.handSize}`;
    else if (ev.type === 'awaiting_action') extra = ` power=${ev.power} kind=${ev.actionKind}`;
    else if (ev.type === 'summon_figure') extra = ` power=${ev.power} ${ev.followerClass} → ${ev.toRegion}`;
    else if (ev.type === 'tenzen_discard') extra = ` cardId=${ev.cardId}`;
    else if (ev.type === 'battle_kill') extra = ` ${ev.attacker} kills ${ev.targetPower} ${ev.targetClass}`;
    else if (ev.type === 'upgrade_taken') extra = ` power=${ev.power} ${ev.upgradeCardId}`;
    console.log(`${String(r.seq).padStart(3)} ${ev.type}${extra}`);
  }
  console.log(`\nTotal: ${rows.length} events`);
  process.exit(0);
}
main();
