/**
 * Parallel head-to-head bench. Spawns N sub-workers, each running bench-h2h.ts
 * on a seed slice, then aggregates win counts.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/bench-h2h-parallel.ts \
 *     --current-power xarm --games 600 --seed 100000 --iter 1000 \
 *     --workers 16 --out /tmp/bench_h2h_xarm.json
 *
 * Lineup: model_<current_power>.json (live) for that power; ref-dir/
 * model_<other>_ref.json for the other 3.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const baselineMode = process.argv.includes('--baseline');
const currentPower = getArg('--current-power', '');
const gameCount = parseInt(getArg('--games', '600'), 10);
const baseSeed = parseInt(getArg('--seed', '100000'), 10);
const workerCount = parseInt(getArg('--workers', String(Math.max(1, os.cpus().length - 1))), 10);
const mctsIter = getArg('--iter', '1000');
const refDir = getArg('--ref-dir', path.resolve('packages/ai/data/ref'));
const outPath = getArg('--out', '');

if (!baselineMode && !currentPower) {
  console.error('--current-power required (or pass --baseline)');
  process.exit(1);
}
const matchTag = baselineMode ? 'baseline' : currentPower;

const effectiveWorkers = Math.min(workerCount, gameCount);
const baseShare = Math.floor(gameCount / effectiveWorkers);
const extras = gameCount % effectiveWorkers;
interface Slice { start: number; count: number; out: string }
const slices: Slice[] = [];
let cursor = baseSeed;
for (let w = 0; w < effectiveWorkers; w++) {
  const count = baseShare + (w < extras ? 1 : 0);
  slices.push({
    start: cursor, count,
    out: path.resolve(`/tmp/bench_h2h_${matchTag}_w${w}_${process.pid}.json`),
  });
  cursor += count;
}

console.log(`\n=== ${baselineMode ? 'Baseline' : 'H2H'} bench: ${matchTag} ===`);
console.log(`games: ${gameCount}  workers: ${slices.length}  iter: ${mctsIter}\n`);

interface ShardResult {
  current_power: string;
  games: number;
  completed: number;
  no_winners: number;
  co_wins: number;
  wins: Record<string, number>;
  avg_rounds: number;
  vp_mean: Record<string, number>;
}

const t0 = Date.now();

const procs = slices.map((s, w) => new Promise<ShardResult | null>((resolve) => {
  const childArgs = [
    'tsx',
    'packages/server/src/scripts/bench-h2h.ts',
    '--games', String(s.count),
    '--seed', String(s.start),
    '--iter', mctsIter,
    '--ref-dir', refDir,
    '--out', s.out,
  ];
  if (baselineMode) childArgs.push('--baseline');
  else childArgs.push('--current-power', currentPower);
  const proc = spawn('npx', childArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let finished = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    const m = chunk.toString().match(/\[(\d+)\/(\d+)\]/g);
    if (m) {
      const last = m[m.length - 1]!;
      const matchN = last.match(/\[(\d+)\/(\d+)\]/);
      if (matchN) {
        finished = parseInt(matchN[1]!, 10);
        process.stdout.write(`\r  worker ${w}: ${finished}/${s.count}    `);
      }
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[w${w}] ${chunk}`));
  proc.on('exit', (code) => {
    if (code !== 0) { console.error(`\nworker ${w} exit ${code}`); resolve(null); return; }
    try {
      const j = JSON.parse(fs.readFileSync(s.out, 'utf-8')) as ShardResult;
      fs.unlinkSync(s.out);
      resolve(j);
    } catch (err) {
      console.error(`\nworker ${w} read failed: ${err}`);
      resolve(null);
    }
  });
}));

const results = (await Promise.all(procs)).filter((r): r is ShardResult => r !== null);
console.log();

if (results.length === 0) {
  console.error('all shards failed');
  process.exit(1);
}

const POWERS = ['xarm', 'gormen', 'tenzen', 'lasha'] as const;
const totalGames = results.reduce((a, r) => a + r.games, 0);
const totalCompleted = results.reduce((a, r) => a + r.completed, 0);
const totalNoWinners = results.reduce((a, r) => a + r.no_winners, 0);
const totalCoWins = results.reduce((a, r) => a + r.co_wins, 0);
type PowerKey = typeof POWERS[number];
const wins: Record<PowerKey, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
const vpSum: Record<PowerKey, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
let totalRoundsWeighted = 0;
for (const r of results) {
  for (const p of POWERS) {
    wins[p] = wins[p] + (r.wins[p] ?? 0);
    vpSum[p] = vpSum[p] + (r.vp_mean[p] ?? 0) * r.games;
  }
  totalRoundsWeighted += r.avg_rounds * r.games;
}

const aggregated = {
  current_power: matchTag,
  baseline: baselineMode,
  games: totalGames,
  completed: totalCompleted,
  no_winners: totalNoWinners,
  co_wins: totalCoWins,
  wins,
  win_rates: Object.fromEntries(POWERS.map(p => [p, (wins[p] ?? 0) / totalGames])),
  avg_rounds: totalRoundsWeighted / totalGames,
  vp_mean: Object.fromEntries(POWERS.map(p => [p, (vpSum[p] ?? 0) / totalGames])),
  iter: parseInt(mctsIter, 10),
  seed_base: baseSeed,
  wall_time_s: (Date.now() - t0) / 1000,
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(aggregated, null, 2));
  console.log(`\nwrote ${outPath}`);
}

if (baselineMode) {
  console.log(`\nbaseline (${totalGames} games): ${POWERS.map(p => `${p}:${(((aggregated.win_rates[p] ?? 0))*100).toFixed(1)}%`).join(' ')} | rounds ${aggregated.avg_rounds.toFixed(2)} | ${aggregated.wall_time_s.toFixed(0)}s`);
} else {
  const cp = currentPower as PowerKey;
  const cw = wins[cp];
  const cwRate = aggregated.win_rates[cp] ?? 0;
  console.log(`\n${currentPower}: ${(cwRate * 100).toFixed(1)}% (${cw}/${totalGames}) | rounds ${aggregated.avg_rounds.toFixed(2)} | ${aggregated.wall_time_s.toFixed(0)}s`);
}
