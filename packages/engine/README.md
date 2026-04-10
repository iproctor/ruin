# @ruin/engine

Pure-TypeScript game logic for Ruin (4-player asymmetric strategy game). No I/O, no React, no DB — just `applyAction(state, action) → { state, log }`.

## Public API

Exported from `src/index.ts`:

- **State**: `GameState`, `Power`, `Phase`, `Action` (discriminated union of ~16 action kinds)
- **Setup**: `createInitialState(config)` — deterministic from seed
- **Reducers**: `applyAction(state, action)`, `applyActionForPreview(state, action)`, `autoAdvance(result)`
- **Queries**: `getLegalActions(state, power)`, `checkVictory(state)`
- **Constants**: `REGIONS`, `CHAOS_CARDS`, `WORLD_CARDS`, `UPGRADES`, `THREAT_DIALS`, etc.
- **RNG**: `makeRng`, `shuffle` (seeded mulberry32)

## Layout

```
src/
├── types.ts          discriminated unions for GameState, Action, etc.
├── constants.ts      static game data: regions, cards, upgrades, dials
├── setup.ts          createInitialState()
├── reducers.ts       applyAction dispatch + autoAdvance loop
├── helpers.ts        immutable updatePower / updateRegion + queries
├── legalActions.ts   per-pendingAction legal-action enumeration
├── victory.ts        win-condition checking
├── dice.ts           seeded RNG + dice rolls
└── phases/
    ├── world.ts          draw + place world cards
    ├── draw.ts           refill hands (Tenzen discard prompt)
    ├── summoning.ts      summon figures, play cards, pass
    ├── battle.ts         dice + hit assignment
    ├── corruption.ts     domination + corruption + ruination
    ├── end.ts            cleanup, hero tokens, dial advancement
    └── cardChoices.ts    on-play card effect handlers
```

## Round flow

`world → draw → summoning → battle → corruption → end → next round`

Phases marked **autonomous** run inside `autoAdvance()` without player input. Phases that need a decision set `state.pendingAction` and the loop pauses until the matching action is submitted.

## Action flow

1. Caller invokes `applyAction(state, action)`.
2. `applyActionSwitch` routes to the handler in `phases/*` based on `action.kind`.
3. Handler returns a new state (immutable), optionally setting/clearing `pendingAction`.
4. `autoAdvance` runs through autonomous phases until it hits a `pendingAction` or game over.
5. Returns `{ state, log }`.

`applyActionForPreview` does step 1-3 only — used by the client to preview a move without racing through autonomous phases.

## Tests

```bash
pnpm --filter engine test
```

Jest with `ts-jest`. Tests live in `src/__tests__/`.
