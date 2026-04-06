// Seeded PRNG (mulberry32) so games are deterministic and replayable.
// The server provides a seed; the AI can inject its own RNG for simulation.

export type Rng = () => number; // returns [0, 1)

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roll n dice, returning results 1–6. Exploding handled by caller. */
export function rollDice(n: number, rng: Rng): number[] {
  const results: number[] = [];
  for (let i = 0; i < n; i++) {
    results.push(Math.floor(rng() * 6) + 1);
  }
  return results;
}

/** Roll with explosions: any 6 adds an extra die (recursively). */
export function rollWithExplosions(n: number, rng: Rng): number[] {
  const results: number[] = [];
  let toRoll = n;
  while (toRoll > 0) {
    const roll = Math.floor(rng() * 6) + 1;
    results.push(roll);
    toRoll--;
    if (roll === 6) toRoll++; // explosion
  }
  return results;
}

/** Count hits from a set of dice rolls (4, 5, or 6 = hit). */
export function countHits(rolls: number[]): number {
  return rolls.filter(r => r >= 4).length;
}

/** Shuffle array in-place using Fisher-Yates. */
export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}
