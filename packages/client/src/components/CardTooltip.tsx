import { createPortal } from 'react-dom';
import { CARD_BY_ID, WORLD_CARD_BY_ID, UPGRADE_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';
import { MAGIC } from '../lib/gameColors.js';

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
      className="gt"
      style={{
        left,
        top,
        width: 250,
        ['--tt-accent' as string]: powerColor,
        ['--tt-glow' as string]: `${powerColor}55`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span className="gt-title" style={{ margin: 0 }}>{card.name}</span>
        {isChaos && (
          <span style={{
            background: powerColor,
            color: '#0a0806',
            padding: '1px 9px',
            fontFamily: "'Cinzel', serif",
            fontWeight: 700,
            fontSize: '0.85rem',
            borderRadius: 1,
          }}>
            {(card as { cost: number }).cost}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, fontFamily: "'Cinzel', serif", fontSize: '0.62rem', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
        {isWorld && (card as { hasCometIcon?: boolean }).hasCometIcon && (
          <span style={{ color: 'var(--game-brass-hot)', whiteSpace: 'nowrap' }}>☄ Comet</span>
        )}
        {isChaos && (
          <>
            <span style={{ color: powerColor, whiteSpace: 'nowrap' }}>
              {POWER_LABELS[(card as { power: string }).power as keyof typeof POWER_LABELS]}
            </span>
            <span className="gt-fade">·</span>
            <span className="gt-muted" style={{ whiteSpace: 'nowrap' }}>
              {TIMING_LABELS[(card as { timing: string }).timing] ?? (card as { timing: string }).timing}
            </span>
            {(card as { hasMagicSymbol: boolean }).hasMagicSymbol && (
              <>
                <span className="gt-fade">·</span>
                <span style={{ color: MAGIC, whiteSpace: 'nowrap' }}>✦ Magic</span>
              </>
            )}
          </>
        )}
      </div>

      {isChaos && (
        <p className="gt-body" style={{ margin: 0 }}>
          {(card as { effect: string }).effect}
        </p>
      )}
      {isWorld && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <p className="gt-body" style={{ margin: 0 }}>
            <span className="gt-sublabel" style={{ marginRight: 4 }}>Immediate</span>
            {(card as { immediateEffect: string }).immediateEffect}
          </p>
          {(card as { persistentEffect: string | null }).persistentEffect && (
            <p style={{ margin: 0, color: 'var(--game-brass-hot)' }}>
              <span className="gt-sublabel" style={{ marginRight: 4 }}>Persistent</span>
              {(card as { persistentEffect: string }).persistentEffect}
            </p>
          )}
        </div>
      )}
      {isUpgrade && (
        <p className="gt-body" style={{ margin: 0 }}>
          {(card as { effect: string }).effect}
        </p>
      )}
    </div>,
    document.body,
  );
}
