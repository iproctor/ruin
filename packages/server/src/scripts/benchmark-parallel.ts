/**
 * Parallel benchmark. Spawns N workers, each running benchmark.ts on a slice
 * of seeds, then aggregates the per-worker JSON metrics into a combined report.
 *
 * Usage:
 *   pnpm benchmark:parallel [--games 24] [--seed 100] [--workers 6]
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

const gameCount = parseInt(getArg('--games', '24'), 10);
const baseSeed = parseInt(getArg('--seed', '100'), 10);
const workerCount = parseInt(getArg('--workers', String(Math.max(1, os.cpus().length - 1))), 10);
const finalOut = getArg('--out', '');

const perWorker = Math.ceil(gameCount / workerCount);
interface Slice { start: number; count: number; out: string }
const slices: Slice[] = [];
for (let w = 0; w < workerCount; w++) {
  const start = baseSeed + w * perWorker;
  const count = Math.min(perWorker, gameCount - w * perWorker);
  if (count <= 0) break;
  slices.push({
    start, count,
    out: path.resolve(`/tmp/bench_w${w}_${process.pid}.json`),
  });
}

console.log(`\n=== Parallel benchmark ===`);
console.log(`games: ${gameCount}  workers: ${slices.length}  per-worker: ${perWorker}\n`);

const t0 = Date.now();

interface WorkerMetrics {
  games: number;
  completed: number;
  winRates: Record<string, number>;
  dacRatePerPower: Record<string, number>;
  doubleTickRatePerPower?: Record<string, number>;
  avgRounds: number;
  winConditions: Record<string, number>;
  errors: number;
  timeSeconds: number;
  playIndicators?: {
    lashaNobleMovesPerGame: number;
    lashaRuinScoresPerGame: number;
    xarmWarCryPreventedPerGame: number;
    gormenPopulousDominationsPerGame: number;
    tenzenAvgCultists: number;
    tenzenCardsPlayedPerGame: number;
    vpFromDominationPerGame?: Record<string, number>;
    vpFromRuinationPerGame?: Record<string, number>;
  };
  vpStats?: Record<string, { mean: number; sd: number; min: number; max: number }>;
  avgVpSpread?: number;
}

const procs = slices.map((s, w) => new Promise<WorkerMetrics | null>((resolve) => {
  const proc = spawn('npx', [
    'tsx',
    'packages/server/src/scripts/benchmark.ts',
    '--games', String(s.count),
    '--seed', String(s.start),
    '--out', s.out,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let finished = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    const lines = text.split('\n').filter(l => /^\s+\d+\/\d+ seed/.test(l));
    finished += lines.length;
    if (lines.length > 0) {
      process.stdout.write(`\r  worker ${w}: ${finished}/${s.count}    `);
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[w${w}] ${chunk}`));
  proc.on('exit', (code) => {
    if (code !== 0) { resolve(null); return; }
    try {
      const j = JSON.parse(fs.readFileSync(s.out, 'utf-8')) as WorkerMetrics;
      fs.unlinkSync(s.out);
      resolve(j);
    } catch (err) {
      console.error(`worker ${w}: failed to read metrics: ${err}`);
      resolve(null);
    }
  });
}));

const results = (await Promise.all(procs)).filter((r): r is WorkerMetrics => r !== null);
console.log();

if (results.length === 0) {
  console.error('all workers failed');
  process.exit(1);
}

// Aggregate
const POWERS = ['xarm', 'gormen', 'tenzen', 'lasha'];
const totalGames = results.reduce((a, r) => a + r.games, 0);
const totalCompleted = results.reduce((a, r) => a + r.completed, 0);
const totalErrors = results.reduce((a, r) => a + r.errors, 0);

const totalWins: Record<string, number> = {};
const totalDac: Record<string, number> = {};
const totalDoubleTick: Record<string, number> = {};
const totalConds: Record<string, number> = {};
let totalRoundsSum = 0;
let totalCompletedAcc = 0;

// Aggregated play indicators (sums of per-game averages, weighted by per-worker
// completed count, then divided by totalCompleted at the end)
const aggInd = {
  lashaNobleMoves: 0,
  lashaRuinScores: 0,
  xarmWarCryPrevented: 0,
  gormenPopulousDominations: 0,
  tenzenAvgCultists: 0,
  tenzenCardsPlayed: 0,
  vpFromDom: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<string, number>,
  vpFromRuin: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<string, number>,
};

// VP aggregation (weighted means, pooled variance, overall min/max).
const vpAgg: Record<string, { sum: number; sumSqDev: number; n: number; min: number; max: number }> = {};
for (const p of POWERS) vpAgg[p] = { sum: 0, sumSqDev: 0, n: 0, min: Infinity, max: -Infinity };
let spreadSum = 0;
let spreadN = 0;

for (const p of POWERS) { totalWins[p] = 0; totalDac[p] = 0; totalDoubleTick[p] = 0; }

for (const r of results) {
  for (const p of POWERS) {
    totalWins[p] = (totalWins[p] ?? 0) + (r.winRates[p] ?? 0) * r.completed;
    totalDac[p]  = (totalDac[p]  ?? 0) + (r.dacRatePerPower[p] ?? 0) * r.avgRounds * r.completed;
    totalDoubleTick[p] = (totalDoubleTick[p] ?? 0)
      + ((r.doubleTickRatePerPower?.[p] ?? 0) * r.avgRounds * r.completed);
  }
  totalRoundsSum += r.avgRounds * r.completed;
  totalCompletedAcc += r.completed;
  for (const [k, v] of Object.entries(r.winConditions)) {
    totalConds[k] = (totalConds[k] ?? 0) + v;
  }
  if (r.vpStats) {
    for (const p of POWERS) {
      const s = r.vpStats[p];
      if (!s || r.completed === 0) continue;
      vpAgg[p]!.sum += s.mean * r.completed;
      // Combine variances using parallel-Welford-ish: sumSqDev grows by n*sd^2.
      vpAgg[p]!.sumSqDev += s.sd * s.sd * r.completed;
      vpAgg[p]!.n += r.completed;
      vpAgg[p]!.min = Math.min(vpAgg[p]!.min, s.min);
      vpAgg[p]!.max = Math.max(vpAgg[p]!.max, s.max);
    }
  }
  if (r.avgVpSpread !== undefined) {
    spreadSum += r.avgVpSpread * r.completed;
    spreadN += r.completed;
  }
  if (r.playIndicators) {
    aggInd.lashaNobleMoves += r.playIndicators.lashaNobleMovesPerGame * r.completed;
    aggInd.lashaRuinScores += r.playIndicators.lashaRuinScoresPerGame * r.completed;
    aggInd.xarmWarCryPrevented += r.playIndicators.xarmWarCryPreventedPerGame * r.completed;
    aggInd.gormenPopulousDominations += r.playIndicators.gormenPopulousDominationsPerGame * r.completed;
    aggInd.tenzenAvgCultists += r.playIndicators.tenzenAvgCultists * r.completed;
    aggInd.tenzenCardsPlayed += r.playIndicators.tenzenCardsPlayedPerGame * r.completed;
    if (r.playIndicators.vpFromDominationPerGame) {
      for (const p of POWERS) aggInd.vpFromDom[p]! += (r.playIndicators.vpFromDominationPerGame[p] ?? 0) * r.completed;
    }
    if (r.playIndicators.vpFromRuinationPerGame) {
      for (const p of POWERS) aggInd.vpFromRuin[p]! += (r.playIndicators.vpFromRuinationPerGame[p] ?? 0) * r.completed;
    }
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`────────────────────────────────────────`);
console.log(`AGGREGATED (${totalCompleted}/${totalGames} games)`);
console.log();
console.log(`WIN RATES:`);
const sortedWins = POWERS
  .map(p => [p, totalCompleted > 0 ? totalWins[p]! / totalCompleted : 0] as const)
  .sort((a, b) => b[1] - a[1]);
for (const [power, w] of sortedWins) {
  const pct = (w * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(Number(pct) / 5));
  console.log(`  ${power.padEnd(8)} ${pct.padStart(5)}%  ${bar}`);
}

console.log(`\nDAC RATE PER POWER (rounds-with-DAC / total-rounds):`);
for (const p of POWERS) {
  const rate = totalRoundsSum > 0 ? totalDac[p]! / totalRoundsSum : 0;
  const bar = '█'.repeat(Math.round(rate * 20));
  const marker = p === 'xarm' ? ' ← xarm is critical' : '';
  console.log(`  ${p.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}${marker}`);
}

console.log(`\nDOUBLE TICK RATE (rounds with ≥2 dial advances / total-rounds):`);
for (const p of POWERS) {
  const rate = totalRoundsSum > 0 ? totalDoubleTick[p]! / totalRoundsSum : 0;
  const bar = '█'.repeat(Math.round(rate * 20));
  console.log(`  ${p.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}`);
}

const avgRounds = totalCompleted > 0 ? totalRoundsSum / totalCompleted : 0;

console.log(`\nPLAY INDICATORS (per game avg):`);
const perGame = (n: number): string => totalCompleted > 0 ? (n / totalCompleted).toFixed(2) : '0.00';
console.log(`  lasha    noble moves:           ${perGame(aggInd.lashaNobleMoves)}`);
console.log(`  lasha    ruination scores:      ${perGame(aggInd.lashaRuinScores)}`);
console.log(`  xarm     war cry prevented:     ${perGame(aggInd.xarmWarCryPrevented)}  (cultists blocked)`);
console.log(`  gormen   populous dominations:  ${perGame(aggInd.gormenPopulousDominations)}`);
console.log(`  tenzen   avg cultists alive:    ${perGame(aggInd.tenzenAvgCultists)}  (per round)`);
console.log(`  tenzen   cards played:          ${perGame(aggInd.tenzenCardsPlayed)}  (per game)`);

console.log(`\nVP SOURCES (per game avg):`);
console.log(`  power     domination  ruination`);
for (const p of POWERS) {
  console.log(`  ${p.padEnd(8)}  ${perGame(aggInd.vpFromDom[p]!).padStart(8)}  ${perGame(aggInd.vpFromRuin[p]!).padStart(9)}`);
}

console.log(`\nVP STATS (final VP per power):`);
for (const p of POWERS) {
  const a = vpAgg[p]!;
  if (a.n === 0) continue;
  const m = (a.sum / a.n).toFixed(1);
  const sd = Math.sqrt(a.sumSqDev / a.n).toFixed(1);
  console.log(`  ${p.padEnd(8)} mean ${m.padStart(5)}  sd ${sd.padStart(4)}  min ${String(a.min).padStart(3)}  max ${String(a.max).padStart(3)}`);
}
if (spreadN > 0) console.log(`  spread (winner − last) avg ${(spreadSum / spreadN).toFixed(1)}`);

console.log(`\nROUNDS: avg ${avgRounds.toFixed(1)}`);
console.log(`\nWIN CONDITIONS:`);
for (const [c, n] of Object.entries(totalConds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(18)} ${n}`);
}

if (totalErrors > 0) console.log(`\nERRORS: ${totalErrors}`);
console.log(`\nTotal wall time: ${elapsed}s\n`);

if (finalOut) {
  const summary = {
    games: totalGames,
    completed: totalCompleted,
    winRates: Object.fromEntries(sortedWins),
    dacRatePerPower: Object.fromEntries(POWERS.map(p => [p, totalRoundsSum > 0 ? totalDac[p]! / totalRoundsSum : 0])),
    doubleTickRatePerPower: Object.fromEntries(POWERS.map(p => [p, totalRoundsSum > 0 ? totalDoubleTick[p]! / totalRoundsSum : 0])),
    playIndicators: {
      lashaNobleMovesPerGame: totalCompleted > 0 ? aggInd.lashaNobleMoves / totalCompleted : 0,
      lashaRuinScoresPerGame: totalCompleted > 0 ? aggInd.lashaRuinScores / totalCompleted : 0,
      xarmWarCryPreventedPerGame: totalCompleted > 0 ? aggInd.xarmWarCryPrevented / totalCompleted : 0,
      gormenPopulousDominationsPerGame: totalCompleted > 0 ? aggInd.gormenPopulousDominations / totalCompleted : 0,
      tenzenAvgCultists: totalCompleted > 0 ? aggInd.tenzenAvgCultists / totalCompleted : 0,
      tenzenCardsPlayedPerGame: totalCompleted > 0 ? aggInd.tenzenCardsPlayed / totalCompleted : 0,
      vpFromDominationPerGame: Object.fromEntries(POWERS.map(p => [p, totalCompleted > 0 ? aggInd.vpFromDom[p]! / totalCompleted : 0])),
      vpFromRuinationPerGame: Object.fromEntries(POWERS.map(p => [p, totalCompleted > 0 ? aggInd.vpFromRuin[p]! / totalCompleted : 0])),
    },
    vpStats: Object.fromEntries(POWERS.map(p => {
      const a = vpAgg[p]!;
      return [p, {
        mean: a.n > 0 ? a.sum / a.n : 0,
        sd: a.n > 0 ? Math.sqrt(a.sumSqDev / a.n) : 0,
        min: a.n > 0 ? a.min : 0,
        max: a.n > 0 ? a.max : 0,
      }];
    })),
    avgVpSpread: spreadN > 0 ? spreadSum / spreadN : 0,
    avgRounds,
    winConditions: totalConds,
    errors: totalErrors,
    wallTime: parseFloat(elapsed),
  };
  fs.writeFileSync(finalOut, JSON.stringify(summary, null, 2));
  console.log(`Aggregated metrics → ${finalOut}\n`);
}
