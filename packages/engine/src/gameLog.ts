import type { PhaseEvent } from './types.js';

/**
 * Collects both human-readable log strings and structured phase events
 * during a single engine step (applyAction → autoAdvance).
 *
 * Passed by reference through phase handlers the same way `log: string[]`
 * was before — handlers call `log.push(msg)` or `log.push(msg, event)`.
 */
export class GameLog {
  readonly entries: string[] = [];
  readonly phaseEvents: PhaseEvent[] = [];

  /** Log a message, optionally with a structured phase event. */
  push(msg: string, event?: PhaseEvent): void {
    this.entries.push(msg);
    if (event) this.phaseEvents.push(event);
  }

  /** Emit a structured phase event without a log message. */
  event(pe: PhaseEvent): void {
    this.phaseEvents.push(pe);
  }

  /** Absorb all entries and events from another GameLog. */
  absorb(other: GameLog): void {
    this.entries.push(...other.entries);
    this.phaseEvents.push(...other.phaseEvents);
  }
}
