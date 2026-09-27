import { createPortal } from 'react-dom';
import GameCard, { CARD_WIDTH, cardInfo } from './cards/GameCard.js';

interface CardTooltipProps {
  cardId: string;
  x: number;
  y: number;
}

/** Hover preview: the full painted card, kept on screen. */
export default function CardTooltip({ cardId, x, y }: CardTooltipProps) {
  if (!cardInfo(cardId)) return null;
  const w = CARD_WIDTH.md;
  const h = w * 1.4;
  const margin = 10;
  let left = x + 18;
  let top = y - h / 2;
  if (left + w > window.innerWidth - margin) left = x - w - 18;
  if (top < margin) top = margin;
  if (top + h > window.innerHeight - margin) top = window.innerHeight - h - margin;

  return createPortal(
    <div className="card-tooltip" style={{ position: 'fixed', left, top, zIndex: 1100, pointerEvents: 'none' }}>
      <GameCard cardId={cardId} size="md" />
    </div>,
    document.body,
  );
}
