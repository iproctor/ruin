/**
 * Measure aleatoric noise floor of MCTS visit-distribution targets.
 *
 * For each of several fixed states, run MCTS N times with independent
 * Dirichlet noise draws. Align the visit distributions by canonical action
 * slot and compute pairwise KL divergence. Mean pairwise KL ≈ the irreducible
 * variance of the policy training target — a lower bound on expected CE that
 * no capacity or feature work can push through.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-noise-floor.ts \
 *     [--power tenzen] [--states 5] [--reps 8] [--iter 10000]
 */

import {
  createInitialState, applyAction, autoAdvance, GameLog,
} from '@ruin/engine';
import { probeMctsSearch } from '@ruin/ai';
import type { GameState, Power } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function isTerminal(state: GameState): boolean {
  return state.winners !== null || state.phase === 'completed';
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1]! : def;
  };
  const itersList = get('--iters', '500,1000,2000,5000,10000').split(',').map(s => parseInt(s, 10));
  return {
    power: get('--power', 'tenzen') as Power,
    states: parseInt(get('--states', '5'), 10),
    reps: parseInt(get('--reps', '8'), 10),
    itersList,
    timeMs: parseInt(get('--time', '60000'), 10),
    seed: parseInt(get('--seed', '1'), 10),
    skipN: parseInt(get('--skip', '5'), 10),
  };
}

function stateAtNthTargetDecision(
  baseSeed: number, targetPower: Power, n: number,
): GameState | null {
  let state: GameState = createInitialState({
    gameId: `noise-${baseSeed}`,
    activePowers: POWERS,
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed: baseSeed,
  });
  ({ state } = autoAdvance({ state, log: new GameLog() }));

  let seen = 0;
  let safety = 0;
  while (!isTerminal(state) && safety < 2000) {
    safety++;
    const pending = state.pendingAction;
    if (!pending) { ({ state } = autoAdvance({ state, log: new GameLog() })); continue; }
    if (pending.waitingFor === targetPower) {
      if (seen === n) return state;
      seen++;
    }
    const cheap = probeMctsSearch(state, pending.waitingFor, { iterations: 500, timeMs: 20000 });
    ({ state } = applyAction(state, cheap.action));
    ({ state } = autoAdvance({ state, log: new GameLog() }));
  }
  return null;
}

function klDivergence(pIdx: Map<number, number>, qIdx: Map<number, number>): number {
  // Union support, add tiny epsilon to avoid log(0).
  const keys = new Set<number>([...pIdx.keys(), ...qIdx.keys()]);
  const eps = 1e-12;
  let kl = 0;
  for (const k of keys) {
    const p = pIdx.get(k) ?? eps;
    const q = qIdx.get(k) ?? eps;
    if (p > eps) kl += p * Math.log2(p / q);
  }
  return kl;
}

function entropy(p: Map<number, number>): number {
  let h = 0;
  for (const pi of p.values()) if (pi > 0) h -= pi * Math.log2(pi);
  return h;
}

async function main() {
  const opts = parseArgs();
  loadLearnedModelIfPresent();

  console.log(`\n=== Aleatoric noise floor probe ===`);
  console.log(`power:       ${opts.power}`);
  console.log(`states:      ${opts.states} (skipping first ${opts.skipN} decisions to reach mid-game)`);
  console.log(`reps:        ${opts.reps} MCTS runs per state per iter budget`);
  console.log(`iter counts: ${opts.itersList.join(', ')}\n`);

  // Fetch all states once (expensive — avoid re-walking per iter count).
  const states: GameState[] = [];
  for (let s = 0; s < opts.states; s++) {
    const seed = opts.seed + s * 1000;
    process.stdout.write(`state ${s} (seed ${seed})... `);
    const st = stateAtNthTargetDecision(seed, opts.power, opts.skipN);
    if (!st) { console.log(`no decision reached`); continue; }
    states.push(st);
    process.stdout.write(`ok\n`);
  }
  if (states.length === 0) { console.log('(no valid states)'); return; }

  // Per-iter aggregate stats.
  type Agg = { iter: number; kl: number; entropy: number; topAgree: number };
  const agg: Agg[] = [];

  for (const iter of opts.itersList) {
    const klsAcross: number[] = [];
    const entropiesAcross: number[] = [];
    const topAgreeAcross: number[] = [];

    for (let s = 0; s < states.length; s++) {
      process.stdout.write(`iter=${iter} state ${s}: `);
      const dists: Array<Map<number, number>> = [];
      const topSlots: number[] = [];
      for (let r = 0; r < opts.reps; r++) {
        process.stdout.write(`r${r} `);
        const stats = probeMctsSearch(states[s]!, opts.power, {
          iterations: iter,
          timeMs: opts.timeMs,
          dirichletNoise: { alpha: 0.3, weight: 0.35 },
        });
        const total = stats.rootActions.reduce((sum, a) => sum + a.visits, 0);
        const m = new Map<number, number>();
        let topSlot = -1, topVisits = -1;
        for (const a of stats.rootActions) {
          if (a.slotIdx < 0 || total === 0) continue;
          m.set(a.slotIdx, (m.get(a.slotIdx) ?? 0) + a.visits / total);
          if (a.visits > topVisits) { topVisits = a.visits; topSlot = a.slotIdx; }
        }
        dists.push(m);
        topSlots.push(topSlot);
      }
      let pairSum = 0, pairCount = 0;
      for (let i = 0; i < dists.length; i++) {
        for (let j = i + 1; j < dists.length; j++) {
          pairSum += klDivergence(dists[i]!, dists[j]!);
          pairCount++;
        }
      }
      const meanKL = pairSum / Math.max(1, pairCount);
      const avgEnt = dists.reduce((s2, d) => s2 + entropy(d), 0) / dists.length;
      const counts = new Map<number, number>();
      for (const ts of topSlots) counts.set(ts, (counts.get(ts) ?? 0) + 1);
      const topAgree = Math.max(...counts.values()) / topSlots.length;
      console.log(`KL ${meanKL.toFixed(3)}  ent ${avgEnt.toFixed(2)}  top-1 ${(topAgree * 100).toFixed(0)}%`);
      klsAcross.push(meanKL); entropiesAcross.push(avgEnt); topAgreeAcross.push(topAgree);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    agg.push({
      iter,
      kl: mean(klsAcross),
      entropy: mean(entropiesAcross),
      topAgree: mean(topAgreeAcross),
    });
  }

  console.log(`\n── summary ──────────────────────────────────────`);
  console.log(`iter      KL(bits)   entropy(bits)   top-1 agree   CE floor est`);
  for (const a of agg) {
    const floor = a.entropy + 0.5 * a.kl;
    console.log(`${String(a.iter).padStart(6)}    ${a.kl.toFixed(3).padStart(5)}       ${a.entropy.toFixed(2).padStart(5)}          ${(a.topAgree * 100).toFixed(0).padStart(3)}%         ${floor.toFixed(2)}`);
  }
  console.log(``);
}

main().catch((e) => { console.error(e); process.exit(1); });
