/**
 * Parallel self-play data collection.
 *
 * Spawns N worker processes, each running collect-data.ts on a slice of seeds.
 * Writes per-worker JSONL files then concatenates them into the final output.
 *
 * Usage:
 *   pnpm collect:parallel [--games 200] [--seed 1] [--workers 4] [--epsilon 0.1]
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

const gameCount = parseInt(getArg('--games', '200'), 10);
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const workerCount = parseInt(getArg('--workers', String(Math.max(1, os.cpus().length - 1))), 10);
const epsilon = getArg('--epsilon', '0.1');
const outPath = getArg('--out', path.resolve('packages/ai/data/training.jsonl'));

// Slice the seed space across workers.
const perWorker = Math.ceil(gameCount / workerCount);
const slices: Array<{ start: number; count: number; out: string }> = [];
for (let w = 0; w < workerCount; w++) {
  const start = baseSeed + w * perWorker;
  const count = Math.min(perWorker, gameCount - w * perWorker);
  if (count <= 0) break;
  slices.push({
    start,
    count,
    out: path.resolve(`packages/ai/data/training_w${w}.jsonl`),
  });
}

console.log(`\n=== Parallel collection ===`);
console.log(`games: ${gameCount}  workers: ${slices.length}  per-worker: ~${perWorker}  epsilon: ${epsilon}`);
console.log(`out:    ${outPath}\n`);

// Truncate per-worker files (collect script appends).
for (const s of slices) {
  if (fs.existsSync(s.out)) fs.unlinkSync(s.out);
}

const t0 = Date.now();

// Spawn workers
const processes = slices.map((s, w) =>
  new Promise<{ ok: boolean; w: number }>((resolve) => {
    const proc = spawn('npx', [
      'tsx',
      'packages/server/src/scripts/collect-data.ts',
      '--games', String(s.count),
      '--seed', String(s.start),
      '--epsilon', epsilon,
      '--out', s.out,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let finishedGames = 0;
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const matches = text.match(/Game \d+\/\d+ \(seed \d+\)/g);
      if (matches) {
        finishedGames += matches.length;
        process.stdout.write(`\r  worker ${w}: ${finishedGames}/${s.count}    `);
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[w${w}] ${chunk}`));
    proc.on('exit', (code) => {
      console.log(`\n  worker ${w} done (${finishedGames}/${s.count} games, exit ${code})`);
      resolve({ ok: code === 0, w });
    });
  })
);

const results = await Promise.all(processes);

const failed = results.filter(r => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} workers failed.`);
}

// Concatenate outputs
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const writeStream = fs.createWriteStream(outPath);
let totalLines = 0;
for (const s of slices) {
  if (!fs.existsSync(s.out)) continue;
  const lines = fs.readFileSync(s.out, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  for (const l of lines) {
    writeStream.write(l + '\n');
    totalLines++;
  }
  fs.unlinkSync(s.out);
}
writeStream.end();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${totalLines} samples → ${outPath}  (${elapsed}s)\n`);
