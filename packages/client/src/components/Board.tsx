import type { GameState, RegionId, Power, TokenType } from '@ruin/engine';

// SVG viewBox is 900x620
const REGION_POSITIONS: Record<RegionId, { x: number; y: number; w: number; h: number; label: string }> = {
  norrsund:     { x: 30,  y: 30,  w: 160, h: 110, label: 'Norrsund' },
  talvimaa:     { x: 230, y: 30,  w: 160, h: 110, label: 'Talvimaa' },
  volensk:      { x: 430, y: 30,  w: 160, h: 110, label: 'Volensk' },
  mittelreich:  { x: 330, y: 180, w: 160, h: 110, label: 'Mittelreich' },
  normagne:     { x: 130, y: 330, w: 160, h: 110, label: 'Normagne' },
  almerida:     { x: 30,  y: 470, w: 160, h: 110, label: 'Almerida' },
  toscavar:     { x: 380, y: 330, w: 160, h: 110, label: 'Toscavar' },
  pelascos:     { x: 530, y: 330, w: 160, h: 110, label: 'Pelascos' },
  the_barrens:  { x: 580, y: 470, w: 160, h: 110, label: 'The Barrens' },
};

const POWER_COLORS: Record<Power, string> = {
  xarm:   '#ef4444',
  gormen: '#22c55e',
  tenzen: '#a855f7',
  lasha:  '#ec4899',
};

const TOKEN_SYMBOLS: Record<TokenType, string> = {
  event:       'E',
  hero:        'H',
  noble:       'N',
  peasant:     'P',
  ratmen:      'R',
  chaos_stone: 'C',
};

const FOLLOWER_CLASS_SYMBOLS: Record<string, string> = {
  cultist:     'C',
  warrior:     'W',
  incarnation: 'I',
};

interface BoardProps {
  state: GameState;
  selectedCardId: string | null;
  highlightRegions?: RegionId[];
  onRegionClick?: (regionId: RegionId) => void;
}

export default function Board({ state, highlightRegions, onRegionClick }: BoardProps) {
  return (
    <svg
      viewBox="0 0 780 610"
      style={{
        width: '100%',
        border: '1px solid #2d2d5e',
        borderRadius: 8,
        background: '#0f0f1f',
        flexShrink: 0,
      }}
    >
      {/* World track */}
      <text x="10" y="595" fill="#888" fontSize="11">
        World: {state.worldTrack.slot1 ?? '—'} / {state.worldTrack.slot2 ?? '—'}
        {'  '}Ruination: {state.ruinationCardsUsed}/5
      </text>

      {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).map(
        ([regionId, pos]) => {
          const region = state.regions[regionId];
          if (!region) return null;

          const isHighlighted = highlightRegions?.includes(regionId);
          const isClickable = !!onRegionClick;
          const isRuined = region.ruinationCardIndex !== null;

          return (
            <g
              key={regionId}
              onClick={() => onRegionClick?.(regionId)}
              style={{ cursor: isClickable ? 'pointer' : 'default' }}
            >
              {/* Region background */}
              <rect
                x={pos.x}
                y={pos.y}
                width={pos.w}
                height={pos.h}
                rx={6}
                fill={isRuined ? '#1a0a0a' : '#1e1e3a'}
                stroke={isHighlighted ? '#facc15' : isRuined ? '#7f1d1d' : '#3a3a6e'}
                strokeWidth={isHighlighted ? 2.5 : 1.5}
              />

              {/* Region name */}
              <text
                x={pos.x + pos.w / 2}
                y={pos.y + 16}
                textAnchor="middle"
                fill={isRuined ? '#f87171' : '#ddd'}
                fontSize="10"
                fontWeight="700"
              >
                {pos.label}
              </text>

              {/* Resistance / Conquest */}
              <text
                x={pos.x + 4}
                y={pos.y + 29}
                fill="#94a3b8"
                fontSize="9"
              >
                R:{region.resistance} C:{region.conquestValue}
              </text>

              {/* Populous indicator */}
              {region.populous && (
                <text x={pos.x + pos.w - 4} y={pos.y + 29} textAnchor="end" fill="#facc15" fontSize="9">
                  POP
                </text>
              )}

              {/* Tokens row */}
              {region.tokens.length > 0 && (
                <g transform={`translate(${pos.x + 4}, ${pos.y + 35})`}>
                  {region.tokens.map((token, i) => (
                    <rect key={i} x={i * 14} y={0} width={12} height={12} rx={2} fill="#374151" />
                  ))}
                  {region.tokens.map((token, i) => (
                    <text
                      key={`t-${i}`}
                      x={i * 14 + 6}
                      y={10}
                      textAnchor="middle"
                      fill="#e5e7eb"
                      fontSize="8"
                      fontWeight="700"
                    >
                      {TOKEN_SYMBOLS[token] ?? '?'}
                    </text>
                  ))}
                </g>
              )}

              {/* Corruption tokens per power */}
              <g transform={`translate(${pos.x + 4}, ${pos.y + 52})`}>
                {(Object.entries(region.corruptionTokens) as [Power, number][])
                  .filter(([, count]) => count > 0)
                  .map(([power, count], i) => (
                    <g key={power} transform={`translate(${i * 22}, 0)`}>
                      <circle cx={7} cy={6} r={6} fill={POWER_COLORS[power]} opacity={0.85} />
                      <text x={7} y={10} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">
                        {count}
                      </text>
                    </g>
                  ))}
              </g>

              {/* Follower figures */}
              <g transform={`translate(${pos.x + 4}, ${pos.y + 68})`}>
                {region.placements.slice(0, 10).map((fig, i) => (
                  <g key={fig.id} transform={`translate(${i * 16}, 0)`}>
                    <circle
                      cx={7}
                      cy={7}
                      r={7}
                      fill={POWER_COLORS[fig.controlledBy ?? fig.power]}
                      opacity={fig.tipped ? 0.4 : 0.9}
                      stroke="#0f0f1f"
                      strokeWidth={1}
                    />
                    <text x={7} y={11} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">
                      {FOLLOWER_CLASS_SYMBOLS[fig.class] ?? '?'}
                    </text>
                  </g>
                ))}
                {region.placements.length > 10 && (
                  <text x={10 * 16 + 4} y={11} fill="#aaa" fontSize="8">
                    +{region.placements.length - 10}
                  </text>
                )}
              </g>

              {/* Chaos card slots */}
              <g transform={`translate(${pos.x + 4}, ${pos.y + pos.h - 22})`}>
                {region.chaosCards.map((card, i) => (
                  <g key={i} transform={`translate(${i * (pos.w / 2 - 6)}, 0)`}>
                    <rect width={pos.w / 2 - 8} height={18} rx={2} fill={card ? '#312e81' : '#1e1e3a'} stroke="#3a3a6e" strokeWidth={1} />
                    <text
                      x={(pos.w / 2 - 8) / 2}
                      y={12}
                      textAnchor="middle"
                      fill={card ? '#c4b5fd' : '#444'}
                      fontSize="7"
                    >
                      {card ? card.cardId.slice(0, 10) : 'empty'}
                    </text>
                  </g>
                ))}
              </g>
            </g>
          );
        },
      )}
    </svg>
  );
}
