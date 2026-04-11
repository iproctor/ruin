import type { Power, FollowerClass, PhaseEvent, RegionId } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

// ── Figure symbol ────────────────────────────────────────────────────────────

function FigureSymbol({ cls, color }: { cls: FollowerClass; color: string }) {
  const size = 14;
  const cx = size / 2;

  return (
    <svg width={size} height={size} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      {cls === 'incarnation' && <rect x={2} y={2} width={10} height={10} rx={1} fill={color} />}
      {cls === 'warrior' && <polygon points={`${cx},2 ${cx + 5},12 ${cx - 5},12`} fill={color} />}
      {cls === 'cultist' && <rect x={4} y={1} width={6} height={12} rx={1} fill={color} />}
      <line x1={1} y1={1} x2={size - 1} y2={size - 1} stroke="#ef4444" strokeWidth={1.5} />
    </svg>
  );
}

// ── Dice ─────────────────────────────────────────────────────────────────────

function DiceValue({ value }: { value: number }) {
  const isHit = value >= 4;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: 3, fontSize: '0.7rem', fontWeight: 700,
      background: isHit ? '#991b1b' : '#1e1e3a',
      color: isHit ? '#fca5a5' : '#64748b',
      border: isHit ? '1px solid #dc2626' : '1px solid #334155',
      marginRight: 2,
    }}>
      {value}
    </span>
  );
}

// ── Battle pane ──────────────────────────────────────────────────────────────

interface BattlePaneProps {
  regionId: RegionId;
  events: PhaseEvent[];
}

interface PowerRow {
  power: Power;
  rolls: Array<{ dice: number[]; hits: number; kind: string }>;
  kills: Array<{ targetPower: Power; targetClass: FollowerClass }>;
}

export default function BattlePane({ regionId, events }: BattlePaneProps) {
  // Filter events for this region
  const regionEvents = events.filter(e => 'regionId' in e && e.regionId === regionId);

  // Group by power
  const powerRows = new Map<Power, PowerRow>();
  function getRow(power: Power): PowerRow {
    let r = powerRows.get(power);
    if (!r) { r = { power, rolls: [], kills: [] }; powerRows.set(power, r); }
    return r;
  }

  for (const evt of regionEvents) {
    if (evt.type === 'battle_roll') {
      getRow(evt.power).rolls.push({ dice: evt.dice, hits: evt.hits, kind: evt.kind });
    } else if (evt.type === 'battle_kill' && ['xarm','gormen','tenzen','lasha'].includes(evt.attacker)) {
      getRow(evt.attacker as Power).kills.push({ targetPower: evt.targetPower, targetClass: evt.targetClass });
    }
  }

  if (powerRows.size === 0) return null;

  return (
    <div style={{
      background: '#0d0d1fee',
      border: '1px solid #7f1d1d',
      borderRadius: 8,
      padding: '8px 10px',
      width: 220,
      fontSize: '0.72rem',
      color: '#e5e7eb',
      boxShadow: '0 0 20px #000a',
    }}>
      {[...powerRows.values()].map((row, i) => (
        <div key={row.power} style={{ marginBottom: 6, borderTop: i === 0 ? undefined : '1px solid #1e1e3a', paddingTop: i === 0 ? 0 : 4 }}>
          <div style={{ color: POWER_COLORS[row.power], fontWeight: 700, fontSize: '0.7rem', marginBottom: 3 }}>
            {POWER_LABELS[row.power]}
          </div>

          {row.rolls.map((roll, ri) => (
            <div key={ri} style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
              {roll.kind !== 'normal' && (
                <span style={{ color: '#94a3b8', fontSize: '0.6rem', marginRight: 4 }}>
                  {roll.kind === 'war_frenzy' ? 'WF' : 'UF'}
                </span>
              )}
              {roll.dice.map((d, di) => <DiceValue key={di} value={d} />)}
              <span style={{ color: '#94a3b8', margin: '0 4px' }}>=</span>
              <span style={{ color: roll.hits > 0 ? '#f87171' : '#64748b', fontWeight: 700 }}>
                {roll.hits}
              </span>
            </div>
          ))}

          {row.kills.length > 0 && (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
              {row.kills.map((kill, ki) => (
                <FigureSymbol
                  key={ki}
                  cls={kill.targetClass}
                  color={POWER_COLORS[kill.targetPower]}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
