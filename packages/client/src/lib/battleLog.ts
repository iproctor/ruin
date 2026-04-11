import type { Power, RegionId, FollowerClass } from '@ruin/engine';

// ── Parsed battle event types ────────────────────────────────────────────────

export interface BattleRoll {
  power: Power;
  dice: number[];
  hits: number;
  kind: 'normal' | 'war_frenzy' | 'undying_fury';
}

export interface BattleKill {
  attacker: string; // power or card name
  targetPower: Power;
  targetClass: FollowerClass;
  targetId: string;
}

export interface BattleRegionRecord {
  regionId: RegionId;
  rolls: BattleRoll[];
  kills: BattleKill[];
  pendingHits: { power: Power; hits: number } | null;
}

// ── Log parsing ──────────────────────────────────────────────────────────────

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const ALL_REGIONS = [
  'norrsund', 'talvimaa', 'volensk', 'mittelreich', 'normagne',
  'almerida', 'toscavar', 'pelascos', 'the_barrens',
];

// "{regionId}: {power} rolls {dice} → {hits} hit(s)."
const NORMAL_ROLL = /^(\w+): (\w+) rolls ([\d,]+) → (\d+) hit/;

// "{regionId}: {cardName} — Xarm rolls {dice} → {hits} hit(s)."  (War Frenzy)
const WAR_FRENZY_ROLL = /^(\w+): .+ — Xarm rolls ([\d,]+) → (\d+) hit/;

// "{regionId}: {cardName} extra battle — {power} rolls {dice} → {hits} hit(s)."
const UNDYING_ROLL = /^(\w+): .+ extra battle — (\w+) rolls ([\d,]+) → (\d+) hit/;

// "{regionId}: {attacker} kills {targetPower} {class} ({id})."
const KILL = /^(\w+): (\w+) kills (\w+) (cultist|warrior|incarnation) \(([^)]+)\)/;

// "{regionId}: {cardName} kills {targetPower} {class} ({id})."  (Corruption's Harvest)
const CARD_KILL = /^(\w+): .+ kills (\w+) (cultist|warrior|incarnation) \(([^)]+)\)/;

// "{regionId}: {power} must assign {hits} hit(s). Waiting for choice."
const HIT_WAIT = /^(\w+): (\w+) must assign (\d+) hit/;

// "== Round {N}: BATTLE =="
const BATTLE_BANNER = /^== Round \d+: BATTLE ==$/;

// "== Round {N}: CORRUPTION =="
const CORRUPTION_BANNER = /^== Round \d+: CORRUPTION ==$/;

export type BattleLogEntry =
  | { type: 'roll'; regionId: string; roll: BattleRoll }
  | { type: 'kill'; regionId: string; kill: BattleKill }
  | { type: 'hit_wait'; regionId: string; power: Power; hits: number }
  | { type: 'battle_start' }
  | { type: 'battle_end' }
  | { type: 'other'; text: string };

/** Parse a single log line into a structured battle event. */
export function parseBattleLogEntry(line: string): BattleLogEntry {
  if (BATTLE_BANNER.test(line)) return { type: 'battle_start' };
  if (CORRUPTION_BANNER.test(line)) return { type: 'battle_end' };

  let m: RegExpMatchArray | null;

  // Undying fury roll (must check before normal roll since format overlaps)
  m = line.match(UNDYING_ROLL);
  if (m) {
    return {
      type: 'roll',
      regionId: m[1]!,
      roll: {
        power: m[2]! as Power,
        dice: m[3]!.split(',').map(Number),
        hits: Number(m[4]),
        kind: 'undying_fury',
      },
    };
  }

  // War Frenzy roll (check before normal — both have "rolls")
  m = line.match(WAR_FRENZY_ROLL);
  if (m && !line.includes('extra battle')) {
    return {
      type: 'roll',
      regionId: m[1]!,
      roll: {
        power: 'xarm',
        dice: m[2]!.split(',').map(Number),
        hits: Number(m[3]),
        kind: 'war_frenzy',
      },
    };
  }

  // Normal roll
  m = line.match(NORMAL_ROLL);
  if (m && POWERS.includes(m[2]! as Power)) {
    return {
      type: 'roll',
      regionId: m[1]!,
      roll: {
        power: m[2]! as Power,
        dice: m[3]!.split(',').map(Number),
        hits: Number(m[4]),
        kind: 'normal',
      },
    };
  }

  // Kill by power
  m = line.match(KILL);
  if (m && POWERS.includes(m[2]! as Power)) {
    return {
      type: 'kill',
      regionId: m[1]!,
      kill: {
        attacker: m[2]!,
        targetPower: m[3]! as Power,
        targetClass: m[4]! as FollowerClass,
        targetId: m[5]!,
      },
    };
  }

  // Kill by card (Corruption's Harvest etc.)
  m = line.match(CARD_KILL);
  if (m) {
    return {
      type: 'kill',
      regionId: m[1]!,
      kill: {
        attacker: 'card',
        targetPower: m[2]! as Power,
        targetClass: m[3]! as FollowerClass,
        targetId: m[4]!,
      },
    };
  }

  // Hit assignment waiting
  m = line.match(HIT_WAIT);
  if (m && POWERS.includes(m[2]! as Power)) {
    return {
      type: 'hit_wait',
      regionId: m[1]!,
      power: m[2]! as Power,
      hits: Number(m[3]),
    };
  }

  return { type: 'other', text: line };
}

/**
 * Build battle records from a range of log entries (battle phase only).
 * Returns a map of regionId → BattleRegionRecord.
 */
export function buildBattleRecords(
  logEntries: string[],
  battleStartIndex: number,
): Map<string, BattleRegionRecord> {
  const records = new Map<string, BattleRegionRecord>();

  function getOrCreate(regionId: string): BattleRegionRecord {
    let rec = records.get(regionId);
    if (!rec) {
      rec = { regionId: regionId as RegionId, rolls: [], kills: [], pendingHits: null };
      records.set(regionId, rec);
    }
    return rec;
  }

  for (let i = battleStartIndex; i < logEntries.length; i++) {
    const entry = parseBattleLogEntry(logEntries[i]!);
    if (entry.type === 'battle_end') break;

    switch (entry.type) {
      case 'roll': {
        const rec = getOrCreate(entry.regionId);
        rec.rolls.push(entry.roll);
        rec.pendingHits = null;
        break;
      }
      case 'kill': {
        const rec = getOrCreate(entry.regionId);
        rec.kills.push(entry.kill);
        break;
      }
      case 'hit_wait': {
        const rec = getOrCreate(entry.regionId);
        rec.pendingHits = { power: entry.power, hits: entry.hits };
        break;
      }
    }
  }

  return records;
}

/**
 * Find the index of the last "== Round N: BATTLE ==" banner in the log.
 * Returns -1 if not found.
 */
export function findBattleBannerIndex(logEntries: string[]): number {
  for (let i = logEntries.length - 1; i >= 0; i--) {
    if (BATTLE_BANNER.test(logEntries[i]!)) return i;
  }
  return -1;
}

/**
 * Determine the "active" region — the last region that had battle events.
 */
export function getActiveRegion(records: Map<string, BattleRegionRecord>): string | null {
  let last: string | null = null;
  for (const [regionId] of records) {
    last = regionId;
  }
  return last;
}
