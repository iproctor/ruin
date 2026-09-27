import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { Power } from '@ruin/engine';
import { CARD_BY_ID, UPGRADE_BY_ID, WORLD_CARD_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../../lib/display.js';
import { anyCardArt } from '../../lib/art.js';
import { PowerSigil } from '../PowerSigil.js';
import './cards.css';

export type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/** Card width in px per size; height follows the 5:7 ratio. */
export const CARD_WIDTH: Record<CardSize, number> = { xs: 46, sm: 104, md: 210, lg: 280, xl: 340 };

const TIMING_LABELS: Record<string, string> = {
  persistent: 'Persistent',
  beginning_of_battle: 'Battle Start',
  end_of_battle: 'Battle End',
  on_play: 'On Play',
  immediate: 'Immediate',
  discard: 'Discard',
  constant: 'Constant',
};

const WORLD_ACCENT = '#8fa6c4';

export interface CardInfo {
  kind: 'chaos' | 'world' | 'upgrade';
  name: string;
  power: Power | null;
  accent: string;
  cost: number | null;
  magic: boolean;
  comet: boolean;
  typeLine: string;
  text: Array<{ label?: string; body: string }>;
  art: string | undefined;
}

export function cardInfo(id: string): CardInfo | null {
  const chaos = CARD_BY_ID[id];
  if (chaos) {
    return {
      kind: 'chaos',
      name: chaos.name,
      power: chaos.power,
      accent: POWER_COLORS[chaos.power],
      cost: chaos.cost,
      magic: chaos.hasMagicSymbol,
      comet: false,
      typeLine: `${POWER_LABELS[chaos.power]} · ${TIMING_LABELS[chaos.timing] ?? chaos.timing}`,
      text: [{ body: chaos.effect }],
      art: anyCardArt(id),
    };
  }
  const world = WORLD_CARD_BY_ID[id];
  if (world) {
    const text: CardInfo['text'] = [{ label: 'Immediate', body: world.immediateEffect }];
    if (world.persistentEffect) text.push({ label: TIMING_LABELS[world.timing] ?? 'Ongoing', body: world.persistentEffect });
    return {
      kind: 'world',
      name: world.name,
      power: null,
      accent: WORLD_ACCENT,
      cost: null,
      magic: false,
      comet: world.hasCometIcon,
      typeLine: `Old World · ${TIMING_LABELS[world.timing] ?? world.timing}`,
      text,
      art: anyCardArt(id),
    };
  }
  const up = UPGRADE_BY_ID[id];
  if (up) {
    return {
      kind: 'upgrade',
      name: up.name,
      power: up.power,
      accent: POWER_COLORS[up.power],
      cost: null,
      magic: false,
      comet: false,
      typeLine: `${POWER_LABELS[up.power]} · ${up.upgradeType === 'power' ? 'Power' : 'Follower'} Upgrade`,
      text: [{ body: up.effect }],
      art: anyCardArt(id),
    };
  }
  return null;
}

interface GameCardProps {
  cardId: string;
  size?: CardSize;
  /** Tilt toward the cursor and show a foil sheen on hover. */
  interactive?: boolean;
  /** Hide the rules text even at large sizes (name + art only). */
  compact?: boolean;
  faceDown?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A fully rendered card: painted art, frame in the owner's colour, cost gem,
 *  name banner and (at md+ sizes) rules text. Scales entirely from --cw. */
export default function GameCard({ cardId, size = 'md', interactive, compact, faceDown, className, style, children }: GameCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const info = cardInfo(cardId);
  const width = CARD_WIDTH[size];
  const showText = !compact && (size === 'md' || size === 'lg' || size === 'xl');

  function onMove(e: React.PointerEvent) {
    if (!interactive || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    ref.current.style.setProperty('--rx', `${(0.5 - py) * 14}deg`);
    ref.current.style.setProperty('--ry', `${(px - 0.5) * 16}deg`);
    ref.current.style.setProperty('--mx', `${px * 100}%`);
    ref.current.style.setProperty('--my', `${py * 100}%`);
  }
  function onLeave() {
    if (!ref.current) return;
    ref.current.style.setProperty('--rx', '0deg');
    ref.current.style.setProperty('--ry', '0deg');
  }

  const cls = [
    'gc',
    `gc-${size}`,
    info ? `gc-${info.kind}` : '',
    interactive ? 'gc-interactive' : '',
    !showText ? 'gc-compact' : '',
    faceDown ? 'gc-down' : '',
    className ?? '',
  ].join(' ');

  const vars = {
    '--cw': `${width}px`,
    '--accent': info?.accent ?? '#888',
    ...style,
  } as CSSProperties;

  if (faceDown || !info) {
    return (
      <div ref={ref} className={cls} style={vars}>
        <div className="gc-back">
          <div className="gc-back-sigils">
            {(['xarm', 'gormen', 'tenzen', 'lasha'] as Power[]).map((p) => (
              <span key={p} style={{ color: POWER_COLORS[p] }}><PowerSigil power={p} size={width * 0.22} /></span>
            ))}
          </div>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div ref={ref} className={cls} style={vars} onPointerMove={onMove} onPointerLeave={onLeave}>
      <div className="gc-inner">
        <div className="gc-art">
          {info.art ? (
            <img src={info.art} alt="" draggable={false} loading="lazy" />
          ) : (
            <div className="gc-art-fallback">
              {info.power && <span style={{ color: info.accent }}><PowerSigil power={info.power} size={width * 0.45} /></span>}
            </div>
          )}
          <div className="gc-art-shade" />
        </div>

        {info.cost !== null && <div className="gc-cost">{info.cost}</div>}
        {info.magic && <div className="gc-magic" title="Magic symbol">✦</div>}
        {info.comet && <div className="gc-comet" title="Comet">☄</div>}

        <div className="gc-name"><span>{info.name}</span></div>

        {showText && (
          <div className="gc-text">
            <div className="gc-type">{info.typeLine}</div>
            {info.text.map((t, i) => (
              <p key={i}>
                {t.label && <span className="gc-text-label">{t.label}. </span>}
                {t.body}
              </p>
            ))}
          </div>
        )}
        <div className="gc-sheen" />
      </div>
      {children}
    </div>
  );
}
