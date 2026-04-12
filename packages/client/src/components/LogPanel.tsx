import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { ChatMessage } from '../hooks/useGameStream.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';
import type { Power, GameEvent, RegionId, FollowerClass } from '@ruin/engine';
import { REGIONS, FOLLOWERS, CARD_BY_ID, UPGRADE_BY_ID, WORLD_CARD_BY_ID } from '@ruin/engine';
import CardTooltip from './CardTooltip.js';

interface LogPanelProps {
  events: GameEvent[];
  chat: ChatMessage[];
  myPower: Power | null;
  onSendChat: (message: string) => Promise<void>;
  connected: boolean;
}

type FilterMode = 'all' | 'events' | 'chat';

// ─── Display helpers ────────────────────────────────────────────────────────

const FIGURE_SYMBOLS: Record<FollowerClass, string> = {
  cultist: '▌',
  warrior: '▲',
  incarnation: '■',
};

function Pw({ power }: { power: Power | string }) {
  const p = power as Power;
  const color = POWER_COLORS[p] ?? '#94a3b8';
  const label = POWER_LABELS[p] ?? power;
  return <span style={{ color }}>{label}</span>;
}

function Rg({ id }: { id: RegionId | string }) {
  const name = REGIONS[id as RegionId]?.name ?? id;
  return <span style={{ color: '#c4a872' }}>{name}</span>;
}

function Fig({ power, cls }: { power: Power | string; cls: FollowerClass | string }) {
  const color = POWER_COLORS[power as Power] ?? '#94a3b8';
  const sym = FIGURE_SYMBOLS[cls as FollowerClass] ?? '?';
  return <span style={{ color }} title={`${POWER_LABELS[power as Power] ?? power} ${FOLLOWERS[power as Power]?.[cls as FollowerClass]?.name ?? cls}`}>{sym}</span>;
}

function HoverCard({ cardId, name, power }: { cardId: string; name: string; power?: Power | string }) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const color = power ? (POWER_COLORS[power as Power] ?? '#94a3b8') : '#94a3b8';
  const onEnter = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Position tooltip to the left of the element
    setHover({ x: rect.left - 260, y: rect.top - 20 });
  }, []);
  return (
    <>
      <span
        style={{ color, cursor: 'default' }}
        onMouseEnter={onEnter}
        onMouseLeave={() => setHover(null)}
      >
        {name}
      </span>
      {hover && <CardTooltip cardId={cardId} x={hover.x} y={hover.y} />}
    </>
  );
}

function Card({ cardId, power }: { cardId: string; power?: Power | string }) {
  const card = CARD_BY_ID[cardId] ?? WORLD_CARD_BY_ID[cardId];
  const name = card?.name ?? cardId;
  return <HoverCard cardId={cardId} name={name} power={power} />;
}

function WCard({ cardId }: { cardId: string }) {
  const card = WORLD_CARD_BY_ID[cardId];
  const name = card?.name ?? cardId;
  return <HoverCard cardId={cardId} name={name} />;
}

function T({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function CStone() {
  return <Tok type="chaos_stone" />;
}

function tokenName(t: string): string {
  switch (t) {
    case 'peasant': return 'Peasant';
    case 'noble': return 'Noble';
    case 'hero': return 'Hero';
    case 'event': return 'Event';
    case 'chaos_stone': return 'Chaos Stone';
    case 'ratmen': return 'Ratmen';
    default: return t;
  }
}

const TOKEN_CHIPS: Record<string, { label: string; bg: string }> = {
  chaos_stone: { label: 'CS', bg: '#14b8a6' },
  noble:       { label: 'Nb', bg: '#eab308' },
  peasant:     { label: 'Pe', bg: '#78716c' },
};

function Tok({ type }: { type: string }) {
  const chip = TOKEN_CHIPS[type];
  if (chip) return <span style={{ color: '#fff', fontWeight: 700, background: chip.bg, borderRadius: 2, padding: '2px 4px', fontSize: '0.55rem', lineHeight: '1.2' }}>{chip.label}</span>;
  return <>{tokenName(type)}</>;
}

// ─── Event renderer ─────────────────────────────────────────────────────────

function renderEvent(event: GameEvent): ReactNode | null {
  switch (event.type) {
    case 'phase_start':
      return <div style={{ color: '#6b7a8a', fontSize: '0.65rem', letterSpacing: '0.05em', marginTop: 4, textTransform: 'uppercase' }}>— {event.phase} —</div>;
    case 'round_start':
      return <div style={{ color: '#8b95a5', fontWeight: 700, fontSize: '0.75rem', marginTop: 6, marginBottom: 2 }}>Round {event.round}</div>;
    case 'game_over':
      return <>Game over! Winners: {event.winners.map((w, i) => <span key={w}>{i > 0 && ', '}<Pw power={w} /></span>)} ({event.condition}).</>;
    case 'awaiting_action':
      return null;

    case 'world_card_drawn':
      return <>World card: <WCard cardId={event.cardId} /></>;
    case 'comet_removed':
      return <T>Comet cards removed from track.</T>;
    case 'world_card_choice':
      return <><WCard cardId={event.cardId} /><T>: {event.description}</T></>;
    case 'token_supply_exhausted':
      return <><Tok type={event.tokenType} /> <T>supply exhausted.</T></>;

    case 'tenzen_discard':
      return event.cardId !== null
        ? <><Pw power="tenzen" /> discards a card.</>
        : <><Pw power="tenzen" /> keeps hand.</>;
    case 'power_draw':
      return <><Pw power={event.power} /> <T>draws {event.drawn} card(s)</T></>;

    case 'summon_figure': {
      if (event.fromRegion !== null) {
        return <><Rg id={event.fromRegion} /><T>,</T> <Fig power={event.power} cls={event.followerClass} /> <T>→</T> <Rg id={event.toRegion} /></>;
      }
      return <><Fig power={event.power} cls={event.followerClass} /> <T>→</T> <Rg id={event.toRegion} /></>;
    }
    case 'play_card':
      return <><Card cardId={event.cardId} power={event.power} /> <T>→</T> <Rg id={event.toRegion} /></>;
    case 'summoning_pass':
      return <><Pw power={event.power} /> <T>passes.</T></>;
    case 'apprentice_choice':
      return event.carry
        ? <><Fig power="tenzen" cls="cultist" /> <T>carries</T> <CStone /> <Rg id={event.fromRegion} /> <T>→</T> <Rg id={event.toRegion} /></>
        : <><Fig power="tenzen" cls="cultist" /> <T>leaves</T> <CStone /> <T>in</T> <Rg id={event.fromRegion} /></>;
    case 'card_effect':
      return renderCardEffect(event);

    case 'battle_region_start':
      return null;
    case 'battle_roll': {
      const label = event.kind === 'war_frenzy'
        ? <><Card cardId="xarm_war_frenzy" power="xarm" /></>
        : event.kind === 'undying_fury'
          ? <><Card cardId="xarm_bloody_rebirth" power="xarm" /> <Pw power={event.power} /></>
          : <Pw power={event.power} />;
      return <><Rg id={event.regionId} /><T>:</T> {label} <T>rolls {event.dice.join(',')} → {event.hits} hit(s)</T></>;
    }
    case 'battle_kill':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.attacker} /> <T>kills</T> <Fig power={event.targetPower} cls={event.targetClass} /></>;
    case 'peasant_claimed':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>claims</T> <Tok type="peasant" /> <T>({event.total} total)</T></>;
    case 'rapture_control':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power="lasha" /> <T>controls</T> <Fig power={event.targetPower} cls={event.targetClass} /></>;
    case 'heartrippers_corruption':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power="xarm" /> <T>{FOLLOWERS.xarm.warrior.name} place {event.tokens} corruption</T></>;
    case 'war_frenzy_partial':
      return <><Rg id={event.regionId} /><T>:</T> <Card cardId="xarm_war_frenzy" power="xarm" /> <T>— {event.hits} hit(s), not killed</T></>;

    case 'domination_result':
      if (event.power === null) {
        return <><Rg id={event.regionId} /><T>: Tied domination ({event.value})</T></>;
      }
      if (event.conquered) {
        return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>dominates ({event.value} vs {event.resistance}) — {event.vp} VP</T></>;
      }
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>leads ({event.value}) but ≤ resistance ({event.resistance})</T></>;
    case 'domination_failed':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>leads ({event.value}) but ≤ resistance ({event.resistance})</T></>;
    case 'corruption_placement':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>places {event.tokens} corruption</T></>;
    case 'war_cry_block':
      return <><Rg id={event.regionId} /><T>:</T> <Card cardId="xarm_war_cry" power="xarm" /> <T>— no corruption placed</T></>;
    case 'deaths_perfume':
      return <><Rg id={event.regionId} /><T>:</T> <Card cardId="gormen_deaths_perfume" power="gormen" /> <T>— {event.tokens} corruption</T></>;
    case 'vile_consumption':
      return <><Rg id={event.regionId} /><T>:</T> <Card cardId="gormen_vile_consumption" power="gormen" /> <T>— {event.figuresRemoved} removed, {event.tokensPlaced} corruption</T></>;
    case 'ruination':
      return <><Rg id={event.regionId} /> <span style={{ color: '#f87171' }}>RUINED!</span> <T>Ruiners score {event.ruinerVP} VP each</T></>;
    case 'ruination_blocked':
      return <><Rg id={event.regionId} /><T>: Would ruin but no cards remain</T></>;
    case 'dial_counter':
      return <><Rg id={event.regionId} /><T>:</T> <Pw power={event.power} /> <T>earns dial counter</T></>;
    case 'provender_score':
      return <><Pw power={event.power} /> <T>scores {event.vp} VP ({UPGRADE_BY_ID['gormen_provender_of_rot']!.name})</T></>;

    case 'narcotic_release':
      return <><Card cardId="lasha_narcotic_musk" power="lasha" /> <T>expires, figure released</T></>;
    case 'hero_removal':
      return <><Rg id={event.regionId} /><T>: Hero removes</T> <Fig power={event.power} cls={event.followerClass} /></>;
    case 'world_card_effect':
      return renderWorldCardEffect(event);
    case 'ruination_scoring': {
      const first = event.first.map((p, i) => <span key={p}>{i > 0 && '/'}<Pw power={p} /></span>);
      const second = event.second.length > 0
        ? <>{' '}{event.second.map((p, i) => <span key={p}>{i > 0 && '/'}<Pw power={p} /></span>)} <T>{event.secondVP} VP (2nd)</T></>
        : null;
      return <><Rg id={event.regionId} /><T>: Ruin scoring —</T> {first} <T>{event.firstVP} VP</T>{second}</>;
    }
    case 'dial_advance':
      return <><Pw power={event.power} /> <T>advances dial to {event.position} (threat: {event.threat})</T></>;
    case 'dial_vp':
      return <><Pw power={event.power} /> <T>scores {event.vp} VP from dial</T></>;
    case 'dial_victory':
      return <><Pw power={event.power} /> <span style={{ color: '#f59e0b' }}>reaches victory on dial!</span></>;
    case 'card_drawn':
      return <><Pw power={event.power} /> <T>draws a card ({event.source})</T></>;

    case 'forced_discard':
      return <><Pw power={event.power} /> <T>discards {event.count} card(s) (Meddling)</T></>;
    case 'upgrade_taken':
      return <><Pw power={event.power} /> <T>takes</T> {UPGRADE_BY_ID[event.upgradeCardId]?.name ?? event.upgradeCardId}</>;
    case 'dial_place_token':
      return <><Pw power={event.power} /> <T>places</T> <Tok type={event.tokenType} /> <T>in</T> <Rg id={event.regionId} /></>;
    case 'dial_remove_corruption':
      return <><Pw power={event.power} /> <T>removes</T> <Pw power={event.targetPower} /> <T>corruption from</T> <Rg id={event.regionId} /></>;
    case 'dial_remove_world_token':
      return <><Pw power={event.power} /> <T>removes</T> <Tok type={event.tokenType} /> <T>from</T> <Rg id={event.regionId} /></>;
    case 'hero_forced_removal':
      return <><Pw power={event.power} /> <T>removes</T> <Fig power={event.power} cls={event.followerClass} /> <T>due to Hero</T></>;
    case 'harvest_kill':
      return <><Rg id={event.regionId} /><T>:</T> <Card cardId="gormen_inevitable_rot" power="gormen" /> <T>kills</T> <Fig power={event.targetPower} cls={event.targetClass} /></>;
  }
}

function renderCardEffect(event: Extract<GameEvent, { type: 'card_effect' }>): ReactNode {
  switch (event.subtype) {
    case 'plaguefather_corruption':
      return <><Fig power="gormen" cls="incarnation" /> <T>places {event.tokens} corruption in</T> <Rg id={event.regionId} /></>;
    case 'fractals_summon':
      return <><T>{UPGRADE_BY_ID['tenzen_fractals_up']!.name}: free</T> <Fig power="tenzen" cls="warrior" /> <T>→</T> <Rg id={event.regionId} /></>;
    case 'call_to_war':
      return <><Card cardId="xarm_call_to_war" power={event.power} /><T>:</T> <Fig power={event.power} cls="warrior" /> <Rg id={event.fromRegion} /> <T>→</T> <Rg id={event.toRegion} /></>;
    case 'teleport':
      return <><Card cardId="tenzen_teleport" power={event.power} /><T>:</T> <Fig power={event.power} cls={event.followerClass} /> <Rg id={event.fromRegion} /> <T>→</T> <Rg id={event.toRegion} /></>;
    case 'meddling_of_rats':
      return <><Card cardId="tenzen_the_meddling_of_rats" power="tenzen" /><T>:</T> <Pw power={event.targetPower} /> <T>must discard 2 cards</T></>;
    case 'fate_shield':
      return <><Card cardId="tenzen_fate_shield" power="tenzen" /><T>: a figure is protected</T></>;
    case 'hidden_influence':
      return <><Card cardId="lasha_hidden_influence" power="lasha" /><T>:</T> <Tok type={event.tokenType} /> <Rg id={event.fromRegion} /> <T>→</T> <Rg id={event.toRegion} /></>;
    case 'narcotic_musk':
      return <><Card cardId="lasha_narcotic_musk" power="lasha" /><T>: controls</T> <Fig power={event.power} cls="cultist" /></>;
    case 'decay':
      return <><Card cardId="gormen_decay" power="gormen" /><T>: removes</T> <Pw power={event.power} /> <T>corruption from</T> <Rg id={event.regionId} /></>;
    case 'siphon_power':
      return <><Card cardId="tenzen_siphon_power" power="tenzen" /><T>: +1 PP</T></>;
    case 'depraved_infiltration':
      return <><Card cardId="lasha_depraved_infiltration" power="lasha" /><T>: 1 corruption in</T> <Rg id={event.regionId} /></>;
  }
}

function renderWorldCardEffect(event: Extract<GameEvent, { type: 'world_card_effect' }>): ReactNode {
  switch (event.subtype) {
    case 'normagne_heir_discard':
      return <><WCard cardId="normagne_heir" /><T>:</T> <Pw power={event.power} /> <T>discards a card</T></>;
    case 'northern_heir':
      return <><WCard cardId="northern_heir" /><T>:</T> <Pw power={event.power} /> <T>places</T> <Tok type="noble" /> <T>in</T> <Rg id={event.regionId} /></>;
    case 'diplomatic_envoy':
      return <><WCard cardId="diplomatic_envoy" /><T>:</T> <Pw power={event.power} /> <T>removes</T> <Tok type="noble" /> <T>from</T> <Rg id={event.regionId} /></>;
    case 'chaos_countermeasures':
      return <><WCard cardId="chaos_countermeasures" /><T>:</T> <Pw power={event.power} /> <T>places Hero in</T> <Rg id={event.regionId} /></>;
    case 'great_exorcism_figures':
      return <><WCard cardId="great_exorcism" /><T>: all figures removed from</T> <Rg id={event.regionId} /></>;
    case 'great_exorcism_events':
      return <><WCard cardId="great_exorcism" /><T>: {event.eventsMoved} Event(s) →</T> <Rg id={event.regionId} /></>;
    case 'central_overpopulation':
      return <><WCard cardId="central_overpopulation" /><T>:</T> <Tok type="peasant" /> <T>removed from</T> <Rg id={event.regionId} /></>;
    case 'cleansing_wave':
      return <><WCard cardId="cleansing_wave" /><T>: all corruption removed from</T> <Rg id={event.regionId} /></>;
    case 'noble_scrutiny':
      return <><WCard cardId="noble_scrutiny" /><T>:</T> <Pw power={event.power} /> <T>removes 1 corruption from</T> <Rg id={event.regionId} /></>;
    case 'eastern_armistice':
      return <><WCard cardId="eastern_armistice" /><T>: removes</T> <Fig power={event.power} cls={event.followerClass} /></>;
    case 'peasant_harvest':
      return <><Pw power={event.power} /> <T>{event.vp} VP from</T> <WCard cardId="peasant_harvest" /> <T>({event.claimed}</T> <Tok type="peasant" /><T>)</T></>;
    case 'accelerating_doom':
      return <><WCard cardId="accelerating_doom" /><T>: drawing another World card</T></>;
    case 'forward_scouts_empty':
      return <><WCard cardId="forward_scouts" /><T>: no</T> <CStone /> <T>on board</T></>;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function LogPanel({ events, chat, myPower, onSendChat, connected }: LogPanelProps) {
  const [filter, setFilter] = useState<FilterMode>('all');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Render structured events
  const logEntries = events.map((ev, idx) => ({ node: renderEvent(ev), idx }));

  // Merge events and chat into a single timeline
  type Entry = { kind: 'event'; node: ReactNode; idx: number } | { kind: 'chat'; msg: ChatMessage };
  const evEntries: Entry[] = logEntries
    .filter(e => e.node != null)
    .map((e) => ({ kind: 'event', node: e.node, idx: e.idx }));
  const chats: Entry[]  = chat.map((msg) => ({ kind: 'chat', msg }));
  const merged = [...evEntries, ...chats].sort((a, b) => {
    const aTime = a.kind === 'event' ? a.idx : new Date(a.msg.createdAt).getTime() / 1000;
    const bTime = b.kind === 'event' ? b.idx : new Date(b.msg.createdAt).getTime() / 1000;
    return aTime - bTime;
  });

  const visible = filter === 'all'    ? merged
                : filter === 'events' ? merged.filter((e) => e.kind === 'event')
                :                       merged.filter((e) => e.kind === 'chat');

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [visible.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    try {
      await onSendChat(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: '#13121f', borderTop: '1px solid #2d2d5e', borderRadius: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-end px-3 py-2 shrink-0">
        {/* Filter tabs */}
        <div className="flex gap-1" style={{ borderBottom: '1px solid #2d2d5e' }}>
          {(['all', 'events', 'chat'] as FilterMode[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                fontSize: '0.65rem',
                padding: '1px 7px',
                borderRadius: 0,
                fontWeight: 700,
                cursor: 'pointer',
                border: 'none',
                background: filter === f ? '#312e81' : 'transparent',
                color: filter === f ? '#c7d2fe' : '#64748b',
                textTransform: 'capitalize',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0 space-y-px">
        {visible.length === 0 && (
          <p style={{ color: '#334155', fontSize: '0.75rem', fontStyle: 'italic', padding: '4px 4px' }}>
            {connected ? 'No entries yet.' : 'Connecting…'}
          </p>
        )}
        {visible.map((entry, i) => {
          if (entry.kind === 'event') {
            return (
              <div
                key={`e-${entry.idx}`}
                style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#8d9bb0', padding: '1px 4px' }}
              >
                {entry.node}
              </div>
            );
          }
          const { msg } = entry;
          const color = msg.power ? (POWER_COLORS[msg.power as Power] ?? '#6366f1') : '#6366f1';
          const label = msg.power ? (POWER_LABELS[msg.power as Power] ?? msg.username) : msg.username;
          return (
            <div
              key={`c-${msg.id}`}
              style={{
                fontSize: '0.75rem',
                lineHeight: 1.4,
                padding: '2px 4px',
                borderRadius: 3,
                background: '#0d1a2d',
              }}
            >
              <span style={{ color, fontWeight: 700 }}>{label}: </span>
              <span style={{ color: '#cbd5e1' }}>{msg.message}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Chat input */}
      <div className="shrink-0 flex gap-1 p-2">
        <input
          type="text"
          placeholder={myPower ? 'Chat…' : 'Spectating — chat disabled'}
          disabled={!myPower || sending}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          style={{
            flex: 1,
            fontSize: '0.75rem',
            background: '#1e1e3a',
            border: '1px solid #2d2d5e',
            borderRadius: '4px 4px 0 0',
            color: '#e2e8f0',
            padding: '4px 8px',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!myPower || !input.trim() || sending}
          style={{
            fontSize: '0.75rem',
            padding: '4px 10px',
            borderRadius: '4px 0 0 0',
            border: 'none',
            background: '#312e81',
            color: '#c7d2fe',
            cursor: 'pointer',
            opacity: !myPower || !input.trim() ? 0.4 : 1,
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}
