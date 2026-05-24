import type { Power } from '@ruin/engine';
import { createInitialState } from '@ruin/engine';
import { readFileSync } from 'node:fs';
import { clearModel, loadModel } from '../learn/evaluator.js';
import type { ModelJson } from '../learn/mlp.js';
import { _mctsStats, runMctsWithStats } from '../mcts/search.js';

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function summoningState() {
  const state = createInitialState({
    gameId: 'mcts-stats-test',
    activePowers: POWERS,
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed: 3,
  });
  return {
    ...state,
    phase: 'summoning' as const,
    pendingAction: {
      waitingFor: 'xarm' as const,
      actionKind: 'summoning_action' as const,
      context: {},
    },
  };
}

describe('runMctsWithStats diagnostics', () => {
  beforeAll(() => {
    const model = JSON.parse(readFileSync(new URL('../../data/model.json', import.meta.url), 'utf8')) as ModelJson;
    loadModel(model);
  });

  afterAll(() => {
    clearModel();
  });

  test('returns root debug rows, root trace, and records aggregate stats', () => {
    _mctsStats.total = 0;
    _mctsStats.timeCapped = 0;
    _mctsStats.iters = 0;
    _mctsStats.margins.length = 0;

    const stats = runMctsWithStats(summoningState(), 'xarm', {
      iterations: 3,
      timeMs: 1000,
      rolloutDepth: 0,
      traceIterations: 2,
    });

    expect(stats.searchVisitCounts.length).toBeGreaterThan(0);
    expect(stats.searchDebugRows).toHaveLength(stats.searchVisitCounts.length);
    expect(stats.searchDebugRows.every(row => row.action && Number.isFinite(row.visits))).toBe(true);
    expect(stats.rootTrace).toBeDefined();
    expect(stats.rootTrace!.length).toBeLessThanOrEqual(2);
    expect(_mctsStats.total).toBe(1);
    expect(_mctsStats.iters).toBeGreaterThan(0);
  });
});
