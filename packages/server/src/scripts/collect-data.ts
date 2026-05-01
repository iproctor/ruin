/**
 * Self-play data collection. Plays N headless AI-vs-AI games, recording
 * (feature_vector, winner_power) at every summoning decision point. Writes
 * JSONL to packages/ai/data/training.jsonl.
 *
 * Usage (from repo root):
 *   pnpm collect [--games 100] [--seed 1] [--out path]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, getLegalActions, GameLog, type GameState, type Action, type Power,
} from '@ruin/engine';
import {
  runMcts, runMctsWithStats, greedyAction, extractFeatures, POWERS, powerIndex,
  canonicalActionIndex, ACTION_DIM,
  loadModelForPower, clearPerPowerModels, type ModelJson,
} from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

// Bootstrap: use the learned model if one exists (iterative self-play).
// First run falls back to the hand-tuned evaluator.
loadLearnedModelIfPresent();

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const gameCount = parseInt(getArg('--games', '50'), 10);
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
// Training collection is iter-governed, not time-governed. Consistent per-
// decision quality matters more than throughput consistency — a short time
// cap over-searches easy states and under-searches hard ones, giving uneven
// policy-target quality.
//
// Iter count was briefly 10000 based on the probe showing meaningful KL
// between visits and raw priors at that budget. But probe-iter-agreement
// then showed MCTS picks the SAME chosen action at 3k and 10k in 100% of
// states (20/20). 2k picks the same action 90% of the time — 10% still
// wrong vs deep search. 3k is the convergence point: identical decisions
// to 10k, 3.33x faster.
//
// The residual CE noise at 3k+ is from non-top-slot visit-count variance
// under Dirichlet, not from action instability. Reducing that noise is a
// separate concern (target sharpening, lower Dirichlet weight).
//
// Opponents use the frozen shared model; they don't generate policy
// targets, so their iter budget only needs to produce reasonable play.
const mctsIterations = parseInt(getArg('--iter', '3000'), 10);
const mctsOpponentIterations = parseInt(getArg('--iter-opp', '1000'), 10);
// Time cap is now a safety net only (long-running games shouldn't hang
// indefinitely). Deliberately set well above what 10k iters normally takes.
const mctsTimeMs = parseInt(getArg('--time', '60000'), 10);
// Dirichlet noise on root priors. Weight 0 disables (useful for canary runs
// to isolate whether noise is blocking the iter-budget gain from showing up
// in play quality).
const dirichletWeight = parseFloat(getArg('--dirichlet-weight', '0.35'));
const dirichletAlpha = parseFloat(getArg('--dirichlet-alpha', '0.3'));
const dirichletNoise = dirichletWeight > 0
  ? { alpha: dirichletAlpha, weight: dirichletWeight }
  : undefined;
// epsilon-greedy exploration during data collection: with this probability,
// pick a random legal summoning action instead of MCTS's best. Mostly superseded
// by Dirichlet noise on root priors (cleaner exploration that doesn't sabotage
// games) — default 0. Kept available via --epsilon for back-compat.
const epsilon = parseFloat(getArg('--epsilon', '0'));
// Per-power MCTS iter budget. Tenzen runs at 10k iters with rollout=0:
// the demo-trained value head's per-state prediction is good enough that
// random rollouts dilute the signal. Skipping rollout per-iter is much
// cheaper, freeing budget for deeper search. Fork experiment: 3k+rollout
// → avg 52.6 VP, 1/5 wins; 10k+r0 → avg 55.8 VP, 3/5 wins.
const mctsTenzenIterations = parseInt(getArg('--iter-tenzen', '10000'), 10);
const tenzenRolloutZero = !process.argv.includes('--no-tenzen-rollout-zero');
const iterBudgetFor = (p: Power, base: number): number =>
  p === 'tenzen' ? mctsTenzenIterations : base;
const rolloutDepthFor = (p: Power): number | undefined =>
  p === 'tenzen' && tenzenRolloutZero ? -1 : undefined;
// League training: with --league-size K, the K most recent snapshot models
// are loaded into a pool. Per game, one power is the "learner" (rotated by
// seed) and uses the current model; each other power, with probability
// --league-mix, is assigned a random snapshot as its opponent policy.
// Value-head samples are recorded for all powers (outcome is valid from any
// viewpoint). Policy-head visits are only recorded for the learner —
// snapshot-driven visits would regress the current policy toward snapshots.
// Default 0 = disabled (pure self-play).
const leagueSize = parseInt(getArg('--league-size', '0'), 10);
const leagueMix = parseFloat(getArg('--league-mix', '0.5'));
// Focus power: if set, that power ALWAYS uses its dedicated model (loaded at
// startup via loadModelForPower from model_<power>.json), other powers draw
// from the league pool. Only the focus power's visits are recorded. Used for
// single-power training experiments.
const focusPower = getArg('--focus-power', '');
const outPath = getArg('--out', path.resolve('packages/ai/data/training.jsonl'));

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// ── Snapshot pool (league training) ───────────────────────────────────────────

const snapshotPool: ModelJson[] = [];
if (leagueSize > 0) {
  const snapDir = path.resolve('packages/ai/data');
  if (fs.existsSync(snapDir)) {
    const files = fs.readdirSync(snapDir)
      .filter(f => /^model_iter_\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      })
      .slice(-leagueSize);
    for (const f of files) {
      snapshotPool.push(JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf-8')) as ModelJson);
    }
    console.log(`[league] pool size=${snapshotPool.length}: ${files.join(', ')}`);
  }
  if (snapshotPool.length === 0) {
    console.log(`[league] no snapshots found — league mode inactive`);
  }
}
const leagueActive = snapshotPool.length > 0;

// ── Per-power live models ─────────────────────────────────────────────────────
// Load every model_<power>.json that exists. The focus power uses its own as
// the warm-start target; non-focus powers that have one use it as a stable
// opponent policy (preserves gains from previous focus-training runs — e.g.
// Tenzen's model_tenzen.json keeps playing well while we focus-train Gormen).

const livePerPowerModels: Partial<Record<Power, ModelJson>> = {};
for (const p of ALL_POWERS) {
  const modelPath = path.resolve(`packages/ai/data/model_${p}.json`);
  if (fs.existsSync(modelPath)) {
    livePerPowerModels[p] = JSON.parse(fs.readFileSync(modelPath, 'utf-8')) as ModelJson;
    console.log(`[per-power] loaded model_${p}.json`);
  }
}
if (focusPower && !livePerPowerModels[focusPower as Power]) {
  console.log(`[focus] no model_${focusPower}.json — ${focusPower} will warm-start from shared model`);
}
const focusPowerModel = focusPower ? livePerPowerModels[focusPower as Power] ?? null : null;

// ── Hall of Fame: past strong snapshots, per-power ────────────────────────────
// With probability hofMix, a game plays ANY power (focus or opponent) with a
// random HOF model for that power instead of the live per-power model. Two
// benefits:
//   - Focus power: prevents training-data collapse by guaranteeing some games
//     show the focus power executing its proper strategy.
//   - Opponent powers: stops the focus power from overfitting to one specific
//     opponent policy. E.g. during Gormen focus, Tenzen is sometimes the
//     iter-1285 Tenzen and sometimes the iter-1249 Tenzen — Gormen has to
//     generalize.
const hofMix = parseFloat(getArg('--hof-mix', '0'));
const hofModelsByPower: Partial<Record<Power, ModelJson[]>> = {};
if (hofMix > 0) {
  const hofRoot = path.resolve(`packages/ai/data/hof`);
  if (fs.existsSync(hofRoot)) {
    for (const p of ALL_POWERS) {
      const dir = path.join(hofRoot, p);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && f !== 'manifest.json');
      if (files.length === 0) continue;
      const pool: ModelJson[] = [];
      for (const f of files) {
        pool.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as ModelJson);
      }
      hofModelsByPower[p] = pool;
      console.log(`[hof] ${p}: loaded ${pool.length} hall-of-fame models (mix=${hofMix})`);
    }
  } else {
    console.log(`[hof] no ${hofRoot} — skipping HOF mix`);
  }
}

// ── Ensure output directory exists ────────────────────────────────────────────

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// Open in append mode so multiple runs accumulate.
const out = fs.openSync(outPath, 'a');

// ── Run one game, record samples ──────────────────────────────────────────────

interface Sample {
  x: number[];       // feature vector
  // Power index (0-3) of the acting power. Used to route policy targets
  // to the correct per-power policy head during training.
  p?: number;
  // Optional policy training signal: visit counts on root children at this
  // decision point, mapped to canonical action slots. Sparse map for efficiency.
  visits?: Record<string, number>;
}

interface GameResult {
  samples: Sample[];
  winners: Power[] | null;
  rounds: number;
  // Rank-based target per power. Linear decay: top → 1.0, last → 0.0.
  // Gives the value head signal even in losing positions ("fight to 2nd").
  // Unnormalized — scalar BCE handles any [0,1] target. The legacy 4-way
  // softmax path (unused) gets an ill-conditioned target; not a concern.
  target: number[];
}

function computeRankTarget(state: import('@ruin/engine').GameState, winners: Power[] | null): number[] {
  // Rank by projected rounds-to-win at current pace, via the closer of VP or
  // dial path. Captures trajectory — a power with low VP but fast gain rate
  // ranks above a stalled higher-VP power. Linear decay: top → 1.0, last → 0.0.
  //
  // EXCEPTION: tenzen uses raw VP / 50 (capped at 1.0). Tenzen has plateaued
  // at the bottom of the rank distribution for many cycles, so rank-target
  // collapses to 0.0 every game — no gradient between "lost with 35 VP" and
  // "lost with 5 VP." Raw VP gives the value head a continuous signal across
  // losing trajectories.
  const target = new Array(POWERS.length).fill(0);
  const N = POWERS.length;
  const winnerSet = new Set(winners ?? []);
  const rounds = Math.max(state.round, 1);
  const VP_TARGET = 50;
  const THREAT_TARGET = 35;
  const roundsToWin = (p: Power): number => {
    const ps = state.powers[p];
    const vpRate = ps.victoryPoints / rounds;
    const threatRate = ps.threatValue / rounds;
    const vpProj = vpRate > 0 ? (VP_TARGET - ps.victoryPoints) / vpRate : Infinity;
    const threatProj = threatRate > 0 ? (THREAT_TARGET - ps.threatValue) / threatRate : Infinity;
    return Math.min(vpProj, threatProj);
  };
  const ranked = [...POWERS].sort((a, b) => {
    const aWin = winnerSet.has(a), bWin = winnerSet.has(b);
    if (aWin !== bWin) return aWin ? -1 : 1;
    return roundsToWin(a) - roundsToWin(b);
  });
  for (let i = 0; i < ranked.length; i++) {
    target[POWERS.indexOf(ranked[i]!)] = (N - 1 - i) / (N - 1);
  }
  // Override tenzen's slot with VP-fraction (continuous signal for stuck-at-bottom).
  const tenzenIdx = POWERS.indexOf('tenzen');
  if (tenzenIdx >= 0) {
    const tenzenVP = state.powers['tenzen'].victoryPoints;
    target[tenzenIdx] = Math.min(tenzenVP / VP_TARGET, 1.0);
  }
  return target;
}

function runGame(seed: number): GameResult {
  const samples: Sample[] = [];
  let { state } = autoAdvance({
    state: createInitialState({
      gameId: `collect-${seed}`,
      activePowers: ALL_POWERS,
      playerTypes: Object.fromEntries(ALL_POWERS.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: new GameLog(),
  });

  let actionCount = 0;
  // Deterministic per-game RNG for exploration noise
  let rngState = (seed * 2654435761) >>> 0;
  const rand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff;
  };

  // Per-game Tenzen cutoff sampled from a schedule controlled by
  // TENZEN_CUTOFF_SHIFT ∈ [0, 1]:
  //
  //   - At shift=0, draw cutoff from {1,2,3,4} with weights (1,2,3,4)/10 —
  //     distribution weighted toward HIGH cutoffs (handmade for more rounds).
  //     Canary (2026-04-21) showed pure-learned (shift=1) → tenzen 0% wins,
  //     handmade-active → tenzen 16.5%. So bias collection toward handmade-
  //     heavier games. cutoff=0 never sampled at shift=0.
  //   - At shift=1, always cutoff=0. Learned head runs the whole game.
  //   - At intermediate shift, linearly mix: P(0) = shift, and the rest
  //     of the mass (1 − shift) follows the (1,2,3,4) shape.
  const savedTenzenCutoff = process.env['TENZEN_EVAL_CUTOFF'];
  const shift = Math.min(1, Math.max(0,
    parseFloat(process.env['TENZEN_CUTOFF_SHIFT'] ?? '0')));
  let sampledCutoff: number;
  if (rand() < shift) {
    sampledCutoff = 0;
  } else {
    const r = rand() * 10;
    sampledCutoff = r < 1 ? 1 : r < 3 ? 2 : r < 6 ? 3 : 4;
  }
  process.env['TENZEN_EVAL_CUTOFF'] = String(sampledCutoff);

  // League assignment. Two modes:
  //  - focus mode: only the focus power uses its dedicated model (current
  //    training target). All others draw from the snapshot pool. Only the
  //    focus power's visits are recorded as policy training data.
  //  - normal mode: 2 powers on current, 2 may draw from pool.
  const currentModelPowers = new Set<Power>();
  if (focusPower) {
    // Focus mode: only focus power's visits are recorded.
    clearPerPowerModels();
    currentModelPowers.add(focusPower as Power);
    // Assign a model to each power for this game. For every power with a
    // per-power live model OR a HOF pool:
    //   - with probability hofMix, pick a random HOF entry for that power
    //   - else use the live per-power model if any
    //   - else fall through to shared model.json (no loadModelForPower call)
    // This gives the focus power its training signal AND gives non-focus
    // powers variation (e.g. during Gormen focus, Tenzen sometimes uses a
    // HOF snapshot instead of the stable model_tenzen.json).
    for (const p of ALL_POWERS) {
      const hofPool = hofModelsByPower[p];
      const livePerPower = livePerPowerModels[p];
      const useHof = hofPool && hofPool.length > 0 && rand() < hofMix;
      const chosen = useHof
        ? hofPool![Math.floor(rand() * hofPool!.length)]!
        : livePerPower;
      if (chosen) loadModelForPower(p, chosen);
      // Otherwise falls through to shared model (league or base).
      if (!useHof && !livePerPower && leagueActive && p !== focusPower) {
        // No per-power model at all — let league snapshots cover it
        const snap = snapshotPool[Math.floor(rand() * snapshotPool.length)]!;
        loadModelForPower(p, snap);
      }
    }
  } else if (leagueActive) {
    clearPerPowerModels();
    const offset = seed % ALL_POWERS.length;
    currentModelPowers.add(ALL_POWERS[offset]!);
    currentModelPowers.add(ALL_POWERS[(offset + 1) % ALL_POWERS.length]!);
    for (const p of ALL_POWERS) {
      if (currentModelPowers.has(p)) continue;
      if (rand() < leagueMix) {
        const snap = snapshotPool[Math.floor(rand() * snapshotPool.length)]!;
        loadModelForPower(p, snap);
      } else {
        currentModelPowers.add(p);
      }
    }
  } else {
    for (const p of ALL_POWERS) currentModelPowers.add(p);
  }

  // Truncation disabled. Originally added to push fast play; under MaxN +
  // VP target for tenzen, truncated games unfairly cap VP accumulation
  // (game ends round 3-5 before tenzen can build up), pulling the value
  // target downward even when play was fine. Bench data shows truncation
  // wasn't shifting the meta toward shorter games anyway — letting it run.
  const maxRoundCap = 999;

  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) break;
    if (state.round > maxRoundCap) break; // truncation: leave winners null
    const pending = state.pendingAction;
    if (!pending) break;

    let action: Action;
    let visitsForSample: Record<string, number> | undefined;
    try {
      // Epsilon-greedy: occasionally pick a random legal action instead of MCTS best.
      // Only applies to summoning actions (the strategically interesting ones).
      const explore =
        pending.actionKind === 'summoning_action' && epsilon > 0 && rand() < epsilon;
      if (explore) {
        const legal = getLegalActions(state, pending.waitingFor);
        const candidates = legal.filter(a => a.kind !== 'summoning_pass');
        const pool = candidates.length > 0 ? candidates : legal;
        action = pool[Math.floor(rand() * pool.length)]!;
      } else if (pending.actionKind === 'summoning_action') {
        // Use the stats variant so we can record the visit distribution for
        // policy head training.
        // Iter budget: focus power gets the full budget (its policy head is
        // what we're training, so it needs deep search to produce targets
        // that disagree with its current prior). Opponents use the frozen
        // shared model whose policy head is assumed adequate, so fewer iters
        // suffice to pick a reasonable move. If no focus is set, everyone
        // gets the full budget.
        const iterBudget = !focusPower || pending.waitingFor === focusPower
          ? mctsIterations
          : mctsOpponentIterations;
        const rd = rolloutDepthFor(pending.waitingFor);
        const stats = runMctsWithStats(state, pending.waitingFor, {
          iterations: iterBudgetFor(pending.waitingFor, iterBudget),
          timeMs: mctsTimeMs,
          ...(rd !== undefined ? { rolloutDepth: rd } : {}),
          ...(dirichletNoise ? { dirichletNoise } : {}),
        });
        action = stats.action;
        // Collapse to canonical slot indices and accumulate visits per slot
        // (multiple legal actions may map to the same slot — sum their visits).
        const slotVisits: Record<string, number> = {};
        for (const { action: a, visits } of stats.visitCounts) {
          const idx = canonicalActionIndex(a, state);
          if (idx >= 0 && idx < ACTION_DIM) {
            slotVisits[String(idx)] = (slotVisits[String(idx)] ?? 0) + visits;
          }
        }
        visitsForSample = slotVisits;
      } else {
        const useMcts =
          pending.actionKind === 'battle_hit_assignment' ||
          pending.actionKind === 'tenzen_discard' ||
          pending.actionKind === 'dial_place_token' ||
          pending.actionKind === 'dial_remove_corruption' ||
          pending.actionKind === 'dial_remove_world_token' ||
          pending.actionKind === 'upgrade_choice' ||
          pending.actionKind === 'world_choice' ||
          pending.actionKind === 'hero_removal' ||
          pending.actionKind === 'corruption_harvest_choice' ||
          pending.actionKind === 'card_on_play_choice';
        const subIterBudget = !focusPower || pending.waitingFor === focusPower
          ? mctsIterations
          : mctsOpponentIterations;
        const rd2 = rolloutDepthFor(pending.waitingFor);
        action = useMcts
          ? runMcts(state, pending.waitingFor, {
              iterations: iterBudgetFor(pending.waitingFor, subIterBudget),
              timeMs: mctsTimeMs,
              ...(rd2 !== undefined ? { rolloutDepth: rd2 } : {}),
              ...(dirichletNoise ? { dirichletNoise } : {}),
            })
          : greedyAction(state, pending.waitingFor);
      }
    } catch (err) {
      const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err), stack: null };
      try {
        fs.appendFileSync(
          '/tmp/collect-errors.log',
          `\n=== ${new Date().toISOString()} seed=${seed} ===\n` +
          `kind=action_select round=${state.round} phase=${state.phase} ` +
          `actionKind=${pending.actionKind} power=${pending.waitingFor}\n` +
          `message: ${e.message}\n` +
          (e.stack ? `stack:\n${e.stack}\n` : ''),
        );
      } catch {}
      break;
    }

    // Sample at every summoning decision point. Feature vector trains the
    // value head (any viewpoint is valid). Policy visits are only kept for
    // powers on the current model — snapshot-driven visits would regress
    // the current policy.
    if (pending.actionKind === 'summoning_action') {
      const sample: Sample = {
        x: Array.from(extractFeatures(state, pending.waitingFor)),
        p: powerIndex(pending.waitingFor),
      };
      if (visitsForSample && currentModelPowers.has(pending.waitingFor)) {
        sample.visits = visitsForSample;
      }
      samples.push(sample);
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch (err) {
      const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err), stack: null };
      try {
        fs.appendFileSync(
          '/tmp/collect-errors.log',
          `\n=== ${new Date().toISOString()} seed=${seed} ===\n` +
          `kind=apply round=${state.round} phase=${state.phase} ` +
          `actionKind=${pending.actionKind} power=${pending.waitingFor}\n` +
          `action=${JSON.stringify(action)}\n` +
          `message: ${e.message}\n` +
          (e.stack ? `stack:\n${e.stack}\n` : ''),
        );
      } catch {}
      break;
    }
    actionCount++;
  }

  if (leagueActive) clearPerPowerModels();
  // Restore Tenzen cutoff after per-game randomization
  if (savedTenzenCutoff !== undefined) process.env['TENZEN_EVAL_CUTOFF'] = savedTenzenCutoff;
  else delete process.env['TENZEN_EVAL_CUTOFF'];

  const winners = state.winners;
  // Rank-based target — works for winner, no-winner exhaustion, AND truncated
  // games (winners=null → ranks by VP+threat).
  const target = computeRankTarget(state, winners);
  return { samples, winners, rounds: state.round, target };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== Self-play data collection ===`);
console.log(`Games: ${gameCount}  |  Base seed: ${baseSeed}  |  Out: ${outPath}\n`);

const start = Date.now();
let totalSamples = 0;
let completedGames = 0;
const winCounts: Record<string, number> = {};

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const t0 = Date.now();
  const { samples, winners, rounds, target } = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Both natural exhaustion and truncated games keep their samples — the
  // rank target ranks by VP+threat in winners=null cases.
  for (const s of samples) {
    const row: { x: number[]; t: number[]; p?: number; visits?: Record<string, number> } = {
      x: s.x,
      t: target,
    };
    if (s.p !== undefined) row.p = s.p;
    if (s.visits && Object.keys(s.visits).length > 0) row.visits = s.visits;
    fs.writeSync(out, JSON.stringify(row) + '\n');
  }

  totalSamples += samples.length;
  completedGames++;
  const winStr = winners && winners.length > 0 ? winners.join('+') : 'NO_WINNER';
  winCounts[winStr] = (winCounts[winStr] ?? 0) + 1;
  console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): ${winStr.padEnd(14)} (${rounds}r, ${samples.length} samples, ${elapsed}s)`);
}

fs.closeSync(out);

const total = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n────────────────────────────────────────`);
console.log(`Completed: ${completedGames}/${gameCount} games`);
console.log(`Samples written: ${totalSamples}`);
console.log(`Total time: ${total}s`);
console.log(`\nWinner distribution:`);
for (const [w, c] of Object.entries(winCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${w.padEnd(20)} ${c}`);
}
console.log();
