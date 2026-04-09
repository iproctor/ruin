import { createPortal } from 'react-dom';
import { CARD_BY_ID, WORLD_CARD_BY_ID, UPGRADE_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

interface CardTooltipProps {
  cardId: string;
  x: number;
  y: number;
}

const TIMING_LABELS: Record<string, string> = {
  persistent:          'Persistent',
  beginning_of_battle: 'Battle Start',
  end_of_battle:       'Battle End',
  on_play:             'On Play',
  immediate:           'Immediate',
  discard:             'Discard',
  constant:            'Constant',
};

export default function CardTooltip({ cardId, x, y }: CardTooltipProps) {
  const card = CARD_BY_ID[cardId] ?? WORLD_CARD_BY_ID[cardId] ?? UPGRADE_BY_ID[cardId];
  if (!card) return null;

  // Keep tooltip on screen
  const left = Math.min(x + 12, window.innerWidth - 260);
  const top  = Math.min(y + 12, window.innerHeight - 160);

  const isChaos = 'power' in card && 'cost' in card && 'effect' in card;
  const isWorld = 'immediateEffect' in card;
  const isUpgrade = 'power' in card && 'effect' in card && !('cost' in card);

  const powerColor = isChaos || isUpgrade
    ? POWER_COLORS[(card as { power: string }).power as keyof typeof POWER_COLORS]
    : '#6366f1';

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: 240,
        background: '#0d0d1f',
        border: `1px solid ${powerColor}`,
        borderRadius: 8,
        padding: '10px 12px',
        pointerEvents: 'none',
        zIndex: 9999,
        boxShadow: `0 0 16px ${powerColor}44`,
        fontSize: '0.8rem',
        lineHeight: 1.45,
        color: '#e5e7eb',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, color: '#fff', fontSize: '0.9rem' }}>
          {card.name}
        </span>
        {isChaos && (
          <span
            style={{
              background: powerColor,
              color: '#fff',
              borderRadius: 4,
              padding: '1px 7px',
              fontWeight: 700,
              fontSize: '0.85rem',
            }}
          >
            {(card as { cost: number }).cost}
          </span>
        )}
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: '0.72rem', color: '#94a3b8' }}>
        {isWorld && (card as { hasCometIcon?: boolean }).hasCometIcon && (
          <span style={{ color: '#fbbf24' }}>☄ Comet</span>
        )}
        {isChaos && (
          <>
            <span style={{ color: powerColor }}>
              {POWER_LABELS[(card as { power: string }).power as keyof typeof POWER_LABELS]}
            </span>
            <span>·</span>
            <span>{TIMING_LABELS[(card as { timing: string }).timing] ?? (card as { timing: string }).timing}</span>
            {(card as { hasMagicSymbol: boolean }).hasMagicSymbol && (
              <>
                <span>·</span>
                <span style={{ color: '#a78bfa' }}>✦ Magic</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Effect text */}
      {isChaos && (
        <p style={{ margin: 0, color: '#d1d5db' }}>
          {(card as { effect: string }).effect}
        </p>
      )}
      {isWorld && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={{ margin: 0, color: '#d1d5db' }}>
            <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>IMMEDIATE </span>
            {(card as { immediateEffect: string }).immediateEffect}
          </p>
          {(card as { persistentEffect: string | null }).persistentEffect && (
            <p style={{ margin: 0, color: '#c4b5fd' }}>
              <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>PERSISTENT </span>
              {(card as { persistentEffect: string }).persistentEffect}
            </p>
          )}
        </div>
      )}
      {isUpgrade && (
        <p style={{ margin: 0, color: '#d1d5db' }}>
          {(card as { effect: string }).effect}
        </p>
      )}
    </div>,
    document.body,
  );
}
