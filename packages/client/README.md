# @ruin/client

React + Vite frontend. Game rules live in `@ruin/engine`; this package is presentation only.

## Presentation architecture

| Piece | Where | What it does |
|---|---|---|
| Event pacing | `lib/timing.ts` | One table of how long the event queue waits after each engine event (scaled by the Pace setting). Passed to `useGameStream` as `eventDuration`. |
| Event subscription | `useGameStream().subscribe` | Synchronous per-event callback, never batched by React. Everything cinematic listens here instead of to `lastEvent`. |
| Cinematics | `components/cinematics/` | `CinematicLayer` maps events to scenes: phase banners, world-card reveals, spell flights, battle scenes with thrown 3D dice, ruination, toasts, the aftermath summary and the game-over screen. Rendered over the board area inside a `SafeBoundary`. |
| Particles | `components/fx/` | One full-screen canvas. `useFx().burst(anchor, kind, power)` plus `trail` and `shake`. Positions come from DOM `data-anchor` attributes (`region-<id>`, `slot-<id>-<i>`, `fig-<followerId>`, `power-<power>`), which both boards provide. |
| 3D tabletop | `components/board3d/` | react-three-fiber diorama (lazy-loaded). The canvas is purely visual; every interaction (drop zones, slot clicks, summon buttons, figure drags, tooltips) is an HTML overlay projected from 3D each frame by `ProjectionRegistry`, so dnd-kit and the FX anchors work unchanged. Falls back to the 2D map on error or without WebGL. |
| 2D map | `components/Board.tsx` | Original SVG board, now with portrait tokens and card art. Selectable in settings. |
| Cards | `components/cards/GameCard.tsx` | Painted chaos/world/upgrade card at any size (`xs`–`xl`), all dimensions derived from `--cw`. |
| Sound | `lib/sfx.ts`, `contexts/SoundContext.tsx` | Fully procedural WebAudio (no audio files): god-specific spell timbres, dice, impacts, bells, ruination, an ambient drone. Unlocked on first user gesture. |
| Settings | `contexts/SettingsContext.tsx`, `components/SettingsMenu.tsx` | Board view, cinematics, pace, sound, ambience, volume. Stored per browser in localStorage. Honours `prefers-reduced-motion`. |

## Art

Paintings live in `src/assets/art/<kind>/<id>.webp` and are looked up by `lib/art.ts`; any missing piece falls back to a procedural placeholder.

To regenerate or add art (needs the Codex CLI logged in, with `image_generation`, plus `cwebp`):

```bash
node scripts/art/generate.mjs --jobs 5            # only generates missing art-src/*.png
node scripts/art/generate.mjs --only cards xarm_war_cry   # one kind / specific ids
node scripts/art/process.mjs                      # art-src/*.png → src/assets/art/*.webp
```

Prompts are in `scripts/art/manifest.mjs`. To redo an image, delete its `art-src/<kind>/<id>.png` (raw PNGs are gitignored) and rerun both scripts.

## Dev harnesses (dev server only)

- `/dev`: every card at every size, plus a preview of the upgrade ("boon") modal.
- `/dev/replay?seed=N&as=xarm`: plays a locally generated AI game through the full board, cinematics and sound pipeline, with skip-to-battle, ruin and ending controls. Seeds 1, 5, 33 and 40 include a ruination; seeds 4, 14 and 36 end with no winner.
