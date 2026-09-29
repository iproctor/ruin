/**
 * Move-level comparison of two model sets. Plays games with the base models;
 * at sampled summoning decisions it records, for the acting power:
 *   base    — base model, normal search
 *   base2   — base model again (search is randomized: noise baseline)
 *   cand    — candidate model for that power, normal search
 *   ref     — base model, deep search (more iterations + determinizations)
 * and writes one JSONL row per decision with the four chosen actions.
 *
 * Usage:
 *   npx tsx packages/server/src/scripts/probe-move-agreement.ts --seed 1 --games 4 \
 *     --base models/cur --cand models/r2/warm --out out/agree.jsonl [--p 0.25] [--ref-iter 8000]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInitialState, applyAction, autoAdvance, GameLog, type Power, type Action } from '@ruin/engine';
import { runMcts, greedyAction, loadModelForPower, type ModelJson } from '@ruin/ai';

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const games = parseInt(getArg('--games', '1'), 10);
const baseDir = getArg('--base', 'models/cur');
const candDir = getArg('--cand', '');
const outPath = getArg('--out', '/tmp/agree.jsonl');
const sampleP = parseFloat(getArg('--p', '0.25'));
const iters = parseInt(getArg('--iter', '1000'), 10);
const refIters = parseInt(getArg('--ref-iter', '8000'), 10);
const refDet = parseInt(getArg('--ref-det', '8'), 10);

const ALL: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const read = (d: string, p: Power) => JSON.parse(fs.readFileSync(path.join(d, `model_${p}.json`), 'utf-8')) as ModelJson;
const base = Object.fromEntries(ALL.map(p => [p, read(baseDir, p)])) as Record<Power, ModelJson>;
const cand = Object.fromEntries(ALL.filter(p => fs.existsSync(path.join(candDir, `model_${p}.json`))).map(p => [p, read(candDir, p)])) as Partial<Record<Power, ModelJson>>;
for (const p of ALL) loadModelForPower(p, base[p]);

const SUB = new Set(['battle_hit_assignment', 'tenzen_discard', 'dial_place_token', 'dial_remove_corruption',
  'dial_remove_world_token', 'upgrade_choice', 'world_choice', 'hero_removal', 'corruption_harvest_choice', 'card_on_play_choice']);
const key = (a: Action) => JSON.stringify(a);
const out = fs.openSync(outPath, 'a');
let rngState = (baseSeed * 2654435761) >>> 0;
const rand = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 0xffffffff; };

for (let g = 0; g < games; g++) {
  const seed = baseSeed + g;
  let { state } = autoAdvance({ state: createInitialState({ gameId: `agree-${seed}`, activePowers: ALL,
    playerTypes: Object.fromEntries(ALL.map(p => [p, 'ai'])) as Record<Power, 'ai'>, seed }), log: new GameLog() });
  let n = 0;
  while (state.winners === null && state.phase !== 'completed' && n < 3000) {
    const pending = state.pendingAction;
    if (!pending) break;
    const who = pending.waitingFor;
    let action: Action;
    if (pending.actionKind === 'summoning_action') {
      action = runMcts(state, who, { iterations: iters, timeMs: 600000 });
      if (cand[who] && rand() < sampleP) {
        const base2 = runMcts(state, who, { iterations: iters, timeMs: 600000 });
        const ref = runMcts(state, who, { iterations: refIters, timeMs: 600000, determinizations: refDet });
        loadModelForPower(who, cand[who]!);
        const c = runMcts(state, who, { iterations: iters, timeMs: 600000 });
        loadModelForPower(who, base[who]);
        fs.writeSync(out, JSON.stringify({ seed, round: state.round, power: who,
          base: key(action), base2: key(base2), cand: key(c), ref: key(ref) }) + '\n');
      }
    } else if (SUB.has(pending.actionKind)) {
      action = runMcts(state, who, { iterations: iters, timeMs: 600000 });
    } else {
      action = greedyAction(state, who);
    }
    state = applyAction(state, action).state;
    n++;
  }
}
fs.closeSync(out);
