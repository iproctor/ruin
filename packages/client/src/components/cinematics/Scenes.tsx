import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Phase, Power, RegionId, WinCondition, FollowerClass } from '@ruin/engine';
import { REGIONS, FOLLOWERS } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../../lib/display.js';
import { godArt, regionArt, anyCardArt } from '../../lib/art.js';
import { PowerSigil } from '../PowerSigil.js';
import GameCard from '../cards/GameCard.js';
import { anchorRect, useFx } from '../fx/FxProvider.js';
import { useSound } from '../../contexts/SoundContext.js';

// ── Phase banner ─────────────────────────────────────────────────────────────

const PHASE_TITLE: Partial<Record<Phase, string>> = {
  world: 'The World Turns',
  draw: 'Gathering Power',
  summoning: 'Summoning',
  battle: 'Battle',
  corruption: 'Corruption',
  end: 'Reckoning',
};
const PHASE_TAG: Partial<Record<Phase, string>> = {
  world: 'omens gather over the old continent',
  draw: 'the gods draw breath',
  summoning: 'the faithful answer the call',
  battle: 'steel meets flesh',
  corruption: 'the land festers',
  end: 'the dials of ruin turn',
};

export function PhaseBanner({ phase, round }: { phase: Phase; round: number }) {
  const title = PHASE_TITLE[phase];
  if (!title) return null;
  return (
    <div className={`cin-banner cin-banner-${phase}`}>
      <div className="cin-banner-band">
        <div className="cin-banner-round">Round {round}</div>
        <div className="cin-banner-title">{title}</div>
        <div className="cin-banner-tag">{PHASE_TAG[phase]}</div>
      </div>
    </div>
  );
}

// ── "Your turn" ──────────────────────────────────────────────────────────────

export function TurnBanner({ power }: { power: Power }) {
  return (
    <div className="cin-turn" style={{ ['--accent' as string]: POWER_COLORS[power] }}>
      <span className="cin-turn-sigil"><PowerSigil power={power} size={28} /></span>
      <span>Your move, {POWER_LABELS[power]}</span>
    </div>
  );
}

// ── Another god is deciding ──────────────────────────────────────────────────

export function Deliberating({ power }: { power: Power }) {
  return (
    <div className="cin-think" style={{ ['--accent' as string]: POWER_COLORS[power] }}>
      <span className="cin-think-sigil"><PowerSigil power={power} size={18} /></span>
      <span>{POWER_LABELS[power]} deliberates</span>
      <span className="cin-think-dots"><i /><i /><i /></span>
    </div>
  );
}

// ── World card reveal ────────────────────────────────────────────────────────

export function WorldReveal({ cardId }: { cardId: string }) {
  return (
    <div className="cin-center cin-world">
      <div className="cin-world-glow" />
      <div className="cin-world-card"><GameCard cardId={cardId} size="lg" /></div>
      <div className="cin-caption">A World card is revealed</div>
    </div>
  );
}

// ── Spell cast: card flies from the caster, reveals, then strikes its slot ──

export function SpellReveal({ cardId, power, regionId, slotIndex, speed, onDone }: {
  cardId: string;
  power: Power;
  regionId: RegionId;
  slotIndex: number;
  speed: number;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fx = useFx();
  const sound = useSound();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = 280;
    const h = w * 1.4;
    const cx = vw / 2 - w / 2;
    const cy = vh / 2 - h / 2 - 20;
    const from = anchorRect(`power-${power}`);
    const fromX = from ? from.left + from.width / 2 - w / 2 : vw / 2 - w / 2;
    const fromY = from ? from.top - h / 2 : -h;
    const target = anchorRect(`slot-${regionId}-${slotIndex}`) ?? anchorRect(`region-${regionId}`);
    const toX = target ? target.left + target.width / 2 - w / 2 : cx;
    const toY = target ? target.top + target.height / 2 - h / 2 : cy;
    const toScale = target ? Math.max(0.12, Math.min(0.4, target.width / w)) : 0.2;
    const total = 2100 * speed;
    const anim = el.animate(
      [
        { transform: `translate(${fromX}px, ${fromY}px) scale(0.15) rotateY(180deg)`, opacity: 0 },
        { transform: `translate(${cx}px, ${cy}px) scale(1.04) rotateY(0deg)`, opacity: 1, offset: 0.24 },
        { transform: `translate(${cx}px, ${cy}px) scale(1) rotateY(0deg)`, opacity: 1, offset: 0.66 },
        { transform: `translate(${toX}px, ${toY}px) scale(${toScale}) rotateY(0deg)`, opacity: 0.9, offset: 0.93 },
        { transform: `translate(${toX}px, ${toY}px) scale(${toScale * 0.8}) rotateY(0deg)`, opacity: 0 },
      ],
      { duration: total, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' },
    );
    const impact = setTimeout(() => {
      fx.burst(target ? { x: target.left + target.width / 2, y: target.top + target.height / 2 } : `region-${regionId}`, 'spell', power, 1);
      sound.spellImpact(power);
      fx.shake(4, 320);
    }, total * 0.9);
    anim.onfinish = () => doneRef.current();
    return () => { clearTimeout(impact); anim.cancel(); };
  }, [cardId, power, regionId, slotIndex, speed, fx, sound]);

  return createPortal(
    <div className="cin-spell-layer">
      <div className="cin-spell-dim" style={{ ['--accent' as string]: POWER_COLORS[power], animationDuration: `${2100 * speed}ms` }} />
      <div ref={ref} className="cin-spell-card" style={{ ['--accent' as string]: POWER_COLORS[power] }}>
        <div className="cin-spell-halo" />
        <GameCard cardId={cardId} size="lg" />
      </div>
    </div>,
    document.body,
  );
}

// ── Ruination ────────────────────────────────────────────────────────────────

/** Jagged, branching cracks radiating from the centre (viewBox 100×60). */
function crackPaths(seed: string): string[] {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const paths: string[] = [];
  const walk = (x: number, y: number, angle: number, len: number, depth: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    const steps = 5 + Math.floor(rnd() * 5);
    for (let i = 0; i < steps; i++) {
      angle += (rnd() - 0.5) * 0.9;
      const step = (len / steps) * (0.6 + rnd() * 0.8);
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step * 0.7;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      if (depth < 2 && rnd() < 0.3) walk(x, y, angle + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), len * 0.45, depth + 1);
    }
    paths.push(d);
  };
  const arms = 7;
  for (let i = 0; i < arms; i++) walk(50, 30, (i / arms) * Math.PI * 2 + rnd() * 0.5, 38 + rnd() * 20, 0);
  return paths;
}

export function RuinScene({ regionId, ruiners, vp }: { regionId: RegionId; ruiners: Power[]; vp: number }) {
  const art = regionArt(regionId);
  return (
    <div className="cin-ruin">
      <div className="cin-ruin-art" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <div className="cin-ruin-fire" />
      <svg className="cin-ruin-cracks" viewBox="0 0 100 60" preserveAspectRatio="none">
        {crackPaths(regionId).map((d, i) => (
          <path key={i} d={d} pathLength={1} style={{ animationDelay: `${0.12 + (i % 7) * 0.04}s` }} />
        ))}
      </svg>
      <div className="cin-ruin-text">
        <div className="cin-ruin-region">{REGIONS[regionId].name}</div>
        <div className="cin-ruin-stamp">Ruined</div>
        {ruiners.length > 0 && (
          <div className="cin-ruin-ruiners">
            {ruiners.map((p) => (
              <span key={p} style={{ color: POWER_COLORS[p] }}>
                <PowerSigil power={p} size={26} /> {POWER_LABELS[p]} +{vp} VP
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  power: Power | null;
  title: string;
  body?: string;
  vp?: number;
  cardId?: string;
  big?: boolean;
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="cin-toasts">
      {toasts.map((t) => {
        const color = t.power ? POWER_COLORS[t.power] : '#c68c5a';
        const portrait = t.power ? godArt(t.power) : undefined;
        const cardArt = t.cardId ? anyCardArt(t.cardId) : undefined;
        return (
          <div key={t.id} className={`cin-toast ${t.big ? 'is-big' : ''}`} style={{ ['--accent' as string]: color }}>
            <div className="cin-toast-portrait" style={(cardArt ?? portrait) ? { backgroundImage: `url(${cardArt ?? portrait})` } : undefined}>
              {!(cardArt ?? portrait) && t.power && <span style={{ color }}><PowerSigil power={t.power} size={28} /></span>}
            </div>
            <div className="cin-toast-text">
              <div className="cin-toast-title">{t.title}</div>
              {t.body && <div className="cin-toast-body">{t.body}</div>}
            </div>
            {t.vp !== undefined && t.vp > 0 && <div className="cin-toast-vp">+{t.vp}<small>VP</small></div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Battle aftermath (shown while the queue waits before corruption) ─────────

export interface AftermathRow {
  regionId: RegionId;
  rolls: Array<{ power: Power; dice: number[]; hits: number }>;
  losses: Array<{ power: Power; cls: FollowerClass }>;
}

export function Aftermath({ rows, onContinue }: { rows: AftermathRow[]; onContinue: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onContinue]);

  return (
    <div className="cin-after">
      <div className="cin-after-panel">
        <div className="cin-after-title">Aftermath</div>
        <div className="cin-after-sub">The field falls silent</div>
        <div className="cin-after-rows">
          {rows.map((r) => {
            const powers = [...new Set(r.rolls.map((x) => x.power))];
            return (
              <div key={r.regionId} className="cin-after-row">
                <div className="cin-after-region">{REGIONS[r.regionId].name}</div>
                <div className="cin-after-powers">
                  {powers.map((p) => {
                    const hits = r.rolls.filter((x) => x.power === p).reduce((a, x) => a + x.hits, 0);
                    const dice = r.rolls.filter((x) => x.power === p).flatMap((x) => x.dice);
                    return (
                      <div key={p} className="cin-after-pow" style={{ color: POWER_COLORS[p] }}>
                        <PowerSigil power={p} size={16} />
                        <span className="cin-after-dice">
                          {dice.map((d, i) => <span key={i} className={d >= 4 ? 'is-hit' : ''}>{d}</span>)}
                        </span>
                        <span className="cin-after-hits">{hits}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="cin-after-losses">
                  {r.losses.length === 0 ? <span className="cin-after-none">no losses</span> : r.losses.map((l, i) => (
                    <span key={i} className="cin-after-loss" style={{ color: POWER_COLORS[l.power] }} title={FOLLOWERS[l.power][l.cls].name}>☠</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <button className="cin-btn" onClick={onContinue}>Continue to Corruption</button>
      </div>
    </div>
  );
}

// ── Game over ───────────────────────────────────────────────────────────────

const CONDITION_TEXT: Record<WinCondition, string> = {
  threat_dial: 'Their threat dial reached its apex.',
  vp: 'Fifty victory points of misery.',
  ruination: 'The Old World lies in ruin.',
  world_exhausted: 'The World deck is spent, and no god prevailed.',
};

export interface Deeds { kills: number; dominations: number; ruinations: number }

export function GameOverScreen({ winners, condition, standings, myPowers, onClose, onHome, deeds }: {
  winners: Power[];
  condition: WinCondition;
  standings: Array<{ power: Power; vp: number; threat: number }>;
  myPowers: Power[];
  onClose: () => void;
  onHome: () => void;
  deeds?: Partial<Record<Power, Deeds>>;
}) {
  const primary = winners[0] ?? null;
  // No winner: the mortal world endured. Show the Old World itself.
  const art = primary ? godArt(primary) : regionArt('mittelreich');
  const iWon = winners.some((w) => myPowers.includes(w));
  const iPlayed = myPowers.length > 0;
  return createPortal(
    <div className="cin-over" style={{ ['--accent' as string]: primary ? POWER_COLORS[primary] : '#8fa6c4' }}>
      <div className="cin-over-art" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <div className="cin-over-shade" />
      <div className="cin-over-content">
        <div className="cin-over-kicker">{iPlayed ? (iWon ? 'Victory' : 'Defeat') : 'The game is decided'}</div>
        <div className="cin-over-title">
          {primary ? `${winners.map((w) => POWER_LABELS[w]).join(' & ')} Triumphant` : 'The Old World Endures'}
        </div>
        <div className="cin-over-cond">{CONDITION_TEXT[condition]}</div>
        <div className="cin-over-standings">
          {standings.map((s, i) => (
            <div key={s.power} className={`cin-over-row ${winners.includes(s.power) ? 'is-winner' : ''}`} style={{ color: POWER_COLORS[s.power] }}>
              <span className="cin-over-rank">{i + 1}</span>
              <PowerSigil power={s.power} size={22} />
              <span className="cin-over-name">{POWER_LABELS[s.power]}{myPowers.includes(s.power) ? ' (you)' : ''}</span>
              <span className="cin-over-vp">{s.vp} VP</span>
              <span className="cin-over-threat">threat {s.threat}</span>
              {deeds?.[s.power] && (
                <span className="cin-over-deeds">
                  <span title="Enemies slain">☠ {deeds[s.power]!.kills}</span>
                  <span title="Regions dominated">⚑ {deeds[s.power]!.dominations}</span>
                  <span title="Ruinations joined">✹ {deeds[s.power]!.ruinations}</span>
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="cin-over-buttons">
          <button className="cin-btn" onClick={onHome}>Return Home</button>
          <button className="cin-btn is-ghost" onClick={onClose}>View Board</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Opening: the gods awaken ────────────────────────────────────────────────

export function IntroScene({ powers, myPowers }: { powers: Power[]; myPowers: Power[] }) {
  return (
    <div className="cin-intro">
      <div className="cin-intro-title">The Gods Awaken</div>
      <div className="cin-intro-gods">
        {powers.map((p, i) => (
          <div key={p} className="cin-intro-god" style={{ ['--accent' as string]: POWER_COLORS[p], animationDelay: `${0.25 + i * 0.22}s` }}>
            <div className="cin-intro-art" style={godArt(p) ? { backgroundImage: `url(${godArt(p)})` } : undefined} />
            <div className="cin-intro-name">
              <PowerSigil power={p} size={20} /> {POWER_LABELS[p]}
              {myPowers.includes(p) && <span className="cin-intro-you">you</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="cin-intro-tag">The old continent will not survive the four of you.</div>
    </div>
  );
}
