interface HandProps {
  hand: string[];
  selectedCardId: string | null;
  onSelectCard: (cardId: string) => void;
}

// Very basic card display: we have card IDs but not full card data here.
// The card ID is often descriptive enough (e.g. "blood_tithe", "plague_wind").
function formatCardId(id: string): string {
  return id
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Hand({ hand, selectedCardId, onSelectCard }: HandProps) {
  if (hand.length === 0) return null;

  // Filter out placeholder cards from masked hands
  const visibleCards = hand.filter((id) => id !== '?');

  if (visibleCards.length === 0) return null;

  return (
    <div
      style={{
        background: '#16213e',
        border: '1px solid #2d2d5e',
        borderRadius: 6,
        padding: '0.5rem',
      }}
    >
      <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.4rem', fontWeight: 600 }}>
        Hand ({visibleCards.length} card{visibleCards.length !== 1 ? 's' : ''})
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {visibleCards.map((cardId) => {
          const isSelected = cardId === selectedCardId;
          return (
            <button
              key={cardId}
              onClick={() => onSelectCard(cardId)}
              style={{
                background: isSelected ? '#312e81' : '#1e1e3a',
                border: `2px solid ${isSelected ? '#818cf8' : '#3a3a6e'}`,
                borderRadius: 6,
                padding: '0.4rem 0.6rem',
                color: isSelected ? '#c4b5fd' : '#ddd',
                fontSize: '0.8rem',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.1s',
                minWidth: 90,
              }}
            >
              {formatCardId(cardId)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
