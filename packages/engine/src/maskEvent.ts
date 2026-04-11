/**
 * Mask hidden information in a GameEvent before broadcasting to a specific viewer.
 *
 * Card IDs in other players' hands are hidden info. When broadcasting events,
 * the server calls maskEvent(event, viewerPower) to replace card IDs with '?'
 * for events involving powers the viewer doesn't control.
 *
 * The viewer's own events are returned unmasked — they can see their own cards.
 */

import type { GameEvent, Power } from './types.js';

export function maskEvent(event: GameEvent, viewerPower: Power | null): GameEvent {
  // If no viewer (spectator), mask everything card-related
  const isOwn = (power: Power) => power === viewerPower;

  switch (event.type) {
    // Card draws: mask cardId for non-owner
    case 'card_drawn':
      if (!isOwn(event.power)) return { ...event, cardId: '?' };
      return event;
    case 'ritual_death_draw':
      if (!isOwn(event.power)) return { ...event, cardId: '?' };
      return event;

    // Tenzen discard: mask which card was discarded for non-tenzen
    case 'tenzen_discard':
      if (!isOwn('tenzen') && event.cardId !== null) return { ...event, cardId: '?' };
      return event;

    // Play card: card is now public (on the board), no masking needed
    case 'play_card':
      return event;

    // Normagne heir discard: mask card for non-owner
    case 'world_card_effect':
      if (event.subtype === 'normagne_heir_discard' && !isOwn(event.power)) {
        return { ...event, cardId: '?' };
      }
      return event;

    // Power draw: the number of cards drawn is public, but the cards themselves
    // are hidden. The event only has count + hand size, no card IDs, so no masking needed.
    case 'power_draw':
      return event;

    // Everything else: no hidden info
    default:
      return event;
  }
}

/** Mask all events in a list for a specific viewer. */
export function maskEvents(events: GameEvent[], viewerPower: Power | null): GameEvent[] {
  return events.map(e => maskEvent(e, viewerPower));
}
