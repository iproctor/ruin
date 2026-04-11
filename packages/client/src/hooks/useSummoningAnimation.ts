import { useEffect, useRef, useState } from 'react';
import type { GameEvent, Power } from '@ruin/engine';

const ANIMATION_DURATION = 1000; // 1 second per summoning action

export interface SummoningAnimation {
  /** Figure IDs currently animating into existence (summoned from reserve). */
  appearingFigures: Set<string>;
  /** Figure IDs currently animating a move between regions. */
  movingFigures: Map<string, { fromRegion: string; toRegion: string }>;
  /** Card slot keys (regionId-slotIndex) currently animating in. */
  appearingCards: Set<string>;
}

const EMPTY: SummoningAnimation = {
  appearingFigures: new Set(),
  movingFigures: new Map(),
  appearingCards: new Set(),
};

/**
 * Watches the event stream for summoning-phase events from OTHER powers.
 * Tracks which figures/cards are currently "animating in" so the Board
 * can apply CSS transitions. Animations auto-clear after ANIMATION_DURATION.
 */
export function useSummoningAnimation(
  events: GameEvent[],
  myPowers: Power[],
): SummoningAnimation {
  const [anim, setAnim] = useState<SummoningAnimation>(EMPTY);
  const lastProcessed = useRef(0);

  useEffect(() => {
    if (events.length <= lastProcessed.current) return;

    const newEvents = events.slice(lastProcessed.current);
    lastProcessed.current = events.length;

    for (const ev of newEvents) {
      // Only animate OTHER players' actions
      if ('power' in ev && myPowers.includes((ev as { power: Power }).power)) continue;

      if (ev.type === 'summon_figure') {
        const id = ev.followerId;
        if (ev.fromRegion === null) {
          // From reserve — animate appearance
          setAnim(prev => ({
            ...prev,
            appearingFigures: new Set([...prev.appearingFigures, id]),
          }));
          setTimeout(() => {
            setAnim(prev => {
              const next = new Set(prev.appearingFigures);
              next.delete(id);
              return { ...prev, appearingFigures: next };
            });
          }, ANIMATION_DURATION);
        } else {
          // Move between regions — animate movement
          setAnim(prev => ({
            ...prev,
            movingFigures: new Map([...prev.movingFigures, [id, { fromRegion: ev.fromRegion!, toRegion: ev.toRegion }]]),
          }));
          setTimeout(() => {
            setAnim(prev => {
              const next = new Map(prev.movingFigures);
              next.delete(id);
              return { ...prev, movingFigures: next };
            });
          }, ANIMATION_DURATION);
        }
      }

      if (ev.type === 'play_card') {
        const key = `${ev.toRegion}-${ev.slotIndex}`;
        setAnim(prev => ({
          ...prev,
          appearingCards: new Set([...prev.appearingCards, key]),
        }));
        setTimeout(() => {
          setAnim(prev => {
            const next = new Set(prev.appearingCards);
            next.delete(key);
            return { ...prev, appearingCards: next };
          });
        }, ANIMATION_DURATION);
      }

      // Card effects that move figures (call_to_war, teleport)
      if (ev.type === 'card_effect' && (ev.subtype === 'call_to_war' || ev.subtype === 'teleport')) {
        const id = 'followerId' in ev ? (ev as { followerId: string }).followerId : null;
        if (id) {
          const from = (ev as { fromRegion: string }).fromRegion;
          const to = (ev as { toRegion: string }).toRegion;
          setAnim(prev => ({
            ...prev,
            movingFigures: new Map([...prev.movingFigures, [id, { fromRegion: from, toRegion: to }]]),
          }));
          setTimeout(() => {
            setAnim(prev => {
              const next = new Map(prev.movingFigures);
              next.delete(id);
              return { ...prev, movingFigures: next };
            });
          }, ANIMATION_DURATION);
        }
      }
    }
  }, [events.length, myPowers]);

  return anim;
}
