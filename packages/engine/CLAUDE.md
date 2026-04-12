# Engine — notes for Claude

This package is the source of truth for game rules. Treat it conservatively: AI training and the client both depend on its semantics being stable.

## Invariants — do not violate

- **Immutability.** Never mutate `state` or any nested object. Use `updatePower(s, power, {...})` and `updateRegion(s, regionId, {...})` (helpers.ts) which shallow-spread + merge. Hand/deck/follower arrays are replaced via `[...]`, `filter`, `map`, `slice` — never `push`/`splice`/`shift`.
- **Single follower source of truth.** Each `FollowerInstance` lives in `PowerState.followers[]`. Region figures are derived on the fly via `followersInRegion(state, regionId)` (helpers.ts). When you move/kill/spawn a figure, only update `PowerState.followers` (setting `regionId`, `controlledBy`, etc.).
- **`actionCount` increments.** `applyAction` increments `state.actionCount` on entry. It's the RNG offset for replay determinism. Don't bypass.
- **`pendingAction` is the state machine.** Null = phase will auto-advance. Non-null = waiting for a specific power's action of a specific kind. Handlers must set or clear it. Don't leave it stale.
- **`pendingDialRewards` distinguishes `null` from `[]`.** `null` = not in reward draining; `[]` = drained. End-phase logic relies on this — see reducers.ts:30 (`popDialReward`).
- **`controlledBy ?? power`** is the effective controller for a follower. Enthrallment/Rapture set `controlledBy`; queries that pretend `f.power` is authoritative are buggy.

## Action dispatch

Add a new action kind by:
1. Adding the discriminant to `Action` in `types.ts`.
2. Adding a `case` to `applyActionSwitch` in `reducers.ts`.
3. Adding a `case` to `getLegalActions` in `legalActions.ts` so it appears as legal when expected.
4. Adding the matching zod schema in `packages/server/src/routes/games.ts` so the server accepts it from the wire.
5. Adding a test in `__tests__/`.

Forgetting any of those four is the typical mistake.

## Phase handlers

- Each phase exports a `resolveXxxPhase(state)` (autonomous) and/or `applyXxxAction(state, action)` (interactive).
- Handlers return `{ state, log }`. Never push to a shared log array.
- Setting `pendingAction` causes `autoAdvance` to break out of its loop. Use this to pause for player input.
- Phase transitions happen by setting `state.phase`. The `autoAdvance` switch will pick up the new phase.

## Common pitfalls

- **Filtering by `cardId`.** `hand.filter(id => id !== cardId)` removes ALL copies. To remove one, find the index and slice. (See summoning.ts:136 — the `applyPlayCard` fix.)
- **Re-scoring ruined regions.** `scoreRuinedRegions` iterates all regions with `ruinationCardIndex !== null` every end phase. Once-only scoring is enforced by zeroing `corruptionTokens` after scoring (end.ts). Don't reintroduce a clear in `applyRuination` — the regression test in `__tests__/end.test.ts` ("end-phase ruination scoring runs when region is ruined via corruption phase (regression)") guards against this.
- **`updateRegion` is a shallow merge.** Nested objects like `corruptionTokens` must be spread manually.
- **Ruined regions block almost everything.** Most placement / card / corruption code paths check `isRuined(region)` first. New mechanics that touch a region should usually do the same.

## Don't add to this package

- I/O (file, network, DB) — engine must remain pure
- React, JSX, browser globals
- Anything that depends on the specific persistence layer
- New action-specific zod schemas — those live in the server package
