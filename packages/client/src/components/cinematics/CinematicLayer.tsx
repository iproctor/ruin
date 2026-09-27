import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameEvent, GameState, Phase, Power, RegionId, WinCondition } from '@ruin/engine';
import { followersInRegion, renderText, REGIONS, FOLLOWERS, UPGRADE_BY_ID, CARD_BY_ID } from '@ruin/engine';
import type { EventListener } from '../../hooks/useGameStream.js';
import { POWER_COLORS, POWER_LABELS } from '../../lib/display.js';
import { useFx } from '../fx/FxProvider.js';
import { useSound } from '../../contexts/SoundContext.js';
import { useSettings, SPEED_FACTOR } from '../../contexts/SettingsContext.js';
import BattleScene, { type BattleView } from './BattleScene.js';
import { PhaseBanner, TurnBanner, WorldReveal, SpellReveal, RuinScene, Toasts, Aftermath, GameOverScreen, IntroScene, type Toast, type AftermathRow, type Deeds } from './Scenes.js';
import './cinematics.css';

interface CinematicLayerProps {
  subscribe: (l: EventListener) => () => void;
  state: GameState;
  /** Full event history, for the end-of-game deeds tally. */
  events?: GameEvent[];
  myPowers: Power[];
  paused: boolean;
  onResume: () => void;
}

interface SpellState { id: number; cardId: string; power: Power; regionId: RegionId; slotIndex: number }

const TOAST_MS = 3200;

/** The card (or upgrade) behind each on-play effect, for toast art. */
const EFFECT_CARD: Record<string, string> = {
  plaguefather_corruption: 'gormen_plaguefather_up',
  fractals_summon: 'tenzen_fractals_up',
  call_to_war: 'xarm_call_to_war',
  teleport: 'tenzen_teleport',
  meddling_of_rats: 'tenzen_the_meddling_of_rats',
  fate_shield: 'tenzen_fate_shield',
  hidden_influence: 'lasha_hidden_influence',
  narcotic_musk: 'lasha_narcotic_musk',
  decay: 'gormen_decay',
  siphon_power: 'tenzen_siphon_power',
  depraved_infiltration: 'lasha_depraved_infiltration',
  persistence_matrix_marked: 'tenzen_persistence_matrix',
  persistence_matrix_reset: 'tenzen_persistence_matrix',
};

/** Per-god tally of the game's defining acts, from the event history. */
function tallyDeeds(events: GameEvent[]): Partial<Record<Power, Deeds>> {
  const out: Partial<Record<Power, Deeds>> = {};
  const get = (p: Power) => (out[p] ??= { kills: 0, dominations: 0, ruinations: 0 });
  for (const ev of events) {
    if (ev.type === 'battle_kill') get(ev.attacker).kills++;
    else if (ev.type === 'harvest_kill') get(ev.killedBy).kills++;
    else if (ev.type === 'domination_result' && ev.power && ev.conquered) get(ev.power).dominations++;
    else if (ev.type === 'ruination') for (const p of ev.ruiners) get(p).ruinations++;
  }
  return out;
}

/** "a Heartripper" / "an Addict" from a follower's plural name. */
function oneOf(power: Power, cls: 'cultist' | 'warrior' | 'incarnation'): string {
  const name = FOLLOWERS[power][cls].name;
  if (cls === 'incarnation') return name;
  const single = name.endsWith('ies') ? name.slice(0, -3) + 'y' : name.replace(/s$/, '');
  return `${/^[AEIOU]/.test(single) ? 'an' : 'a'} ${single}`;
}

/**
 * Turns the game's event stream into cinematics: phase banners, card
 * reveals, battle scenes with thrown dice, ruination, toasts and the final
 * reckoning. Renders over the board area; spell flights and the game-over
 * screen portal to <body>.
 */
export default function CinematicLayer({ subscribe, state, events, myPowers, paused, onResume }: CinematicLayerProps) {
  const fx = useFx();
  const sound = useSound();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const speed = SPEED_FACTOR[settings.animSpeed];
  const cine = settings.cinematics;

  const [banner, setBanner] = useState<{ id: number; phase: Phase; round: number } | null>(null);
  const [turn, setTurn] = useState<{ id: number; power: Power } | null>(null);
  const [world, setWorld] = useState<{ id: number; cardId: string } | null>(null);
  const [spell, setSpell] = useState<SpellState | null>(null);
  const [battle, setBattle] = useState<BattleView | null>(null);
  const [aftermath, setAftermath] = useState<AftermathRow[]>([]);
  const [ruin, setRuin] = useState<{ id: number; regionId: RegionId; ruiners: Power[]; vp: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [gameOver, setGameOver] = useState<{ winners: Power[]; condition: WinCondition } | null>(null);
  const [intro, setIntro] = useState(false);

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;
  const myRef = useRef(myPowers);
  myRef.current = myPowers;
  const settingsRef = useRef({ speed, cine });
  settingsRef.current = { speed, cine };
  const lastAwaitMine = useRef(false);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return t;
  }, []);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId();
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_MS * settingsRef.current.speed + (t.big ? 800 : 0));
  }, []);

  /** Fire an effect on the next frame, after React has painted the new state. */
  const soon = useCallback((fn: () => void, extraMs = 0) => {
    setTimeout(() => requestAnimationFrame(fn), extraMs);
  }, []);

  useEffect(() => {
    const onEvent = (ev: GameEvent, after: GameState | null) => {
      const { speed: sp, cine: cinematic } = settingsRef.current;
      const mine = (p: Power | null | undefined) => !!p && myRef.current.includes(p);
      switch (ev.type) {
        case 'phase_start': {
          const id = nextId();
          setBanner({ id, phase: ev.phase, round: ev.round });
          later(() => setBanner((b) => (b?.id === id ? null : b)), 1800 * sp);
          sound.phase(ev.phase);
          sound.setMusicPhase(ev.phase);
          if (ev.phase === 'battle') setAftermath([]);
          if (ev.phase !== 'battle') setBattle(null);
          break;
        }
        case 'world_card_drawn': {
          sound.worldCard();
          if (cinematic) {
            const id = nextId();
            setWorld({ id, cardId: ev.cardId });
            later(() => setWorld((w) => (w?.id === id ? null : w)), 2500 * sp);
          }
          break;
        }
        case 'token_placed':
          soon(() => fx.burst(`region-${ev.regionId}`, ev.tokenType === 'noble' || ev.tokenType === 'hero' ? 'gold' : 'dust', null, 0.6));
          sound.click();
          break;
        case 'awaiting_action': {
          const isMine = mine(ev.power);
          if (isMine && ev.actionKind === 'summoning_action' && !lastAwaitMine.current) {
            sound.yourTurn();
            const id = nextId();
            setTurn({ id, power: ev.power });
            later(() => setTurn((t) => (t?.id === id ? null : t)), 2200);
          }
          lastAwaitMine.current = isMine;
          if (ev.actionKind === 'battle_hit_assignment') {
            setBattle((b) => (b ? { ...b, awaitingPower: ev.power } : b));
          }
          break;
        }
        case 'action_applied':
          // Any decision resolves a pending "chooses victims" prompt.
          setBattle((b) => (b && b.awaitingPower ? { ...b, awaitingPower: null } : b));
          break;
        case 'play_card': {
          sound.cardPlay(ev.power);
          if (cinematic && !mine(ev.power)) {
            setSpell({ id: nextId(), cardId: ev.cardId, power: ev.power, regionId: ev.toRegion, slotIndex: ev.slotIndex });
          } else {
            soon(() => {
              fx.burst([`slot-${ev.toRegion}-${ev.slotIndex}`, `region-${ev.toRegion}`], 'spell', ev.power, 0.8);
              sound.spellImpact(ev.power);
            }, 60);
          }
          break;
        }
        case 'summon_figure': {
          if (ev.fromRegion) {
            sound.move();
            soon(() => fx.trail(`region-${ev.fromRegion}`, `region-${ev.toRegion}`, POWER_COLORS[ev.power], 14, 0.55));
            soon(() => fx.burst([`fig-${ev.followerId}`, `region-${ev.toRegion}`], 'summon', ev.power, 0.7), 450);
          } else {
            sound.summon(ev.power);
            soon(() => fx.burst([`fig-${ev.followerId}`, `region-${ev.toRegion}`], 'summon', ev.power, ev.followerClass === 'incarnation' ? 1.6 : 1));
            if (ev.followerClass === 'incarnation') {
              pushToast({ power: ev.power, title: `${FOLLOWERS[ev.power].incarnation.name} walks the world`, body: `Summoned to ${REGIONS[ev.toRegion].name}`, big: true });
              fx.shake(6, 500);
            }
          }
          break;
        }
        case 'card_effect': {
          const text = renderText(ev);
          switch (ev.subtype) {
            case 'teleport':
              soon(() => fx.burst(`region-${ev.fromRegion}`, 'teleport_out', 'tenzen'));
              soon(() => fx.burst([`fig-${ev.followerId}`, `region-${ev.toRegion}`], 'spell', 'tenzen', 0.7), 350);
              break;
            case 'call_to_war':
              soon(() => fx.trail(`region-${ev.fromRegion}`, `region-${ev.toRegion}`, POWER_COLORS.xarm, 18, 0.5));
              break;
            case 'hidden_influence':
              soon(() => fx.trail(`region-${ev.fromRegion}`, `region-${ev.toRegion}`, POWER_COLORS.lasha, 14, 0.6));
              break;
            case 'fate_shield':
              soon(() => fx.burst([`fig-${ev.followerId}`], 'aura', 'tenzen', 0.8));
              break;
            case 'narcotic_musk':
              soon(() => fx.burst([`fig-${ev.followerId}`], 'aura', 'lasha', 0.8));
              break;
            case 'plaguefather_corruption':
            case 'decay':
            case 'siphon_power':
            case 'depraved_infiltration':
              soon(() => fx.burst(`region-${ev.regionId}`, 'corrupt', ev.subtype === 'siphon_power' ? 'tenzen' : ev.subtype === 'depraved_infiltration' ? 'lasha' : 'gormen', 1.2));
              break;
            case 'fractals_summon':
              soon(() => fx.burst([`fig-${ev.followerId}`, `region-${ev.regionId}`], 'summon', 'tenzen'));
              break;
          }
          const effectCard = EFFECT_CARD[ev.subtype];
          const effectPower = (CARD_BY_ID[effectCard ?? '']?.power ?? UPGRADE_BY_ID[effectCard ?? '']?.power ?? null) as Power | null;
          if (text) pushToast({ power: effectPower, cardId: effectCard, title: text });
          break;
        }
        case 'battle_region_start': {
          const roster = after ? followersInRegion(after, ev.regionId) : [];
          setAftermath((rows) => [...rows.filter((r) => r.regionId !== ev.regionId), { regionId: ev.regionId, rolls: [], losses: [] }]);
          if (cinematic) {
            sound.battleHorn();
            const peasantsAtStart = after ? after.regions[ev.regionId]!.tokens.filter((t) => t === 'peasant').length : 0;
            setBattle({ key: nextId(), regionId: ev.regionId, roster, rolls: [], kills: {}, enthralled: {}, wounded: {}, peasants: [], peasantsAtStart, awaitingPower: null });
          } else {
            sound.battleHorn();
            soon(() => fx.burst(`region-${ev.regionId}`, 'hit', null, 1.2));
          }
          break;
        }
        case 'battle_roll': {
          sound.diceRattle(ev.dice.length);
          setAftermath((rows) => rows.map((r) => r.regionId === ev.regionId ? { ...r, rolls: [...r.rolls, { power: ev.power, dice: ev.dice, hits: ev.hits }] } : r));
          if (cinematic) {
            setBattle((b) => b && b.regionId === ev.regionId
              ? { ...b, awaitingPower: null, rolls: [...b.rolls, { id: nextId(), power: ev.power, dice: ev.dice, hits: ev.hits, kind: ev.kind }] }
              : b);
          } else if (ev.hits > 0) {
            soon(() => fx.burst(`region-${ev.regionId}`, 'hit', ev.power, 0.8), 500);
          }
          break;
        }
        case 'battle_kill': {
          setAftermath((rows) => rows.map((r) => r.regionId === ev.regionId ? { ...r, losses: [...r.losses, { power: ev.targetPower, cls: ev.targetClass }] } : r));
          if (cinematic) {
            setBattle((b) => b && b.regionId === ev.regionId ? { ...b, awaitingPower: null, kills: { ...b.kills, [ev.targetId]: ev.attacker } } : b);
          } else {
            sound.kill();
            soon(() => fx.burst([`fig-${ev.targetId}`, `region-${ev.regionId}`], 'kill', ev.attacker, 0.6));
          }
          break;
        }
        case 'peasant_claimed':
          if (cinematic) setBattle((b) => b && b.regionId === ev.regionId ? { ...b, awaitingPower: null, peasants: [...b.peasants, { power: ev.power, id: nextId() }] } : b);
          else sound.hit();
          break;
        case 'rapture_control':
          sound.cardPlay('lasha');
          if (cinematic) setBattle((b) => b && b.regionId === ev.regionId ? { ...b, enthralled: { ...b.enthralled, [ev.targetId]: 'lasha' } } : b);
          pushToast({ power: 'lasha', title: `The Rapture enthralls ${oneOf(ev.targetPower, ev.targetClass)}`, body: REGIONS[ev.regionId].name });
          break;
        case 'war_frenzy_partial':
          if (cinematic) setBattle((b) => b && b.regionId === ev.regionId ? { ...b, wounded: { ...b.wounded, [ev.followerId]: ev.hits } } : b);
          break;
        case 'chaos_card_discarded':
          // Fire now, while the card is still on the table to anchor to.
          fx.burst([`slot-${ev.regionId}-${ev.slotIndex}`, `region-${ev.regionId}`], 'corrupt', ev.playedBy, 0.45);
          break;
        case 'heartrippers_corruption':
          soon(() => fx.burst(`region-${ev.regionId}`, 'corrupt', 'xarm'));
          break;
        case 'domination_result':
          if (ev.power && ev.conquered) {
            sound.domination(ev.power);
            soon(() => fx.burst(`region-${ev.regionId}`, 'gold', null, 1.3));
            soon(() => fx.burst(`region-${ev.regionId}`, 'aura', ev.power, 1));
            pushToast({ power: ev.power, title: `${POWER_LABELS[ev.power]} dominates ${REGIONS[ev.regionId].name}`, vp: ev.vp, big: true });
          }
          break;
        case 'corruption_placement':
          sound.corruption(ev.power);
          soon(() => fx.burst(`region-${ev.regionId}`, 'corrupt', ev.power, 0.6 + ev.tokens * 0.15), 700 * sp);
          break;
        case 'deaths_perfume':
          soon(() => fx.burst(`region-${ev.regionId}`, 'spell', 'gormen', 0.9));
          pushToast({ power: 'gormen', title: "Death's Perfume blooms", body: REGIONS[ev.regionId].name });
          break;
        case 'vile_consumption':
          soon(() => fx.burst(`region-${ev.regionId}`, 'spell', 'gormen', 1.1));
          pushToast({ power: 'gormen', title: 'Vile Consumption', body: `${ev.figuresRemoved} consumed, ${ev.tokensPlaced} corruption in ${REGIONS[ev.regionId].name}` });
          break;
        case 'war_cry_block':
          soon(() => fx.burst(`region-${ev.regionId}`, 'aura', 'xarm', 0.8));
          pushToast({ power: 'xarm', title: 'War Cry drowns the rot', body: `No corruption in ${REGIONS[ev.regionId].name}` });
          break;
        case 'ruination': {
          sound.ruination();
          soon(() => { fx.burst(`region-${ev.regionId}`, 'ruin', null, 1.3); fx.shake(16, 1100); });
          if (cinematic) {
            const id = nextId();
            setRuin({ id, regionId: ev.regionId, ruiners: ev.ruiners, vp: ev.ruinerVP });
            later(() => setRuin((r) => (r?.id === id ? null : r)), 3600 * sp);
          } else {
            pushToast({ power: null, title: `${REGIONS[ev.regionId].name} is ruined`, big: true });
          }
          break;
        }
        case 'ruination_scoring': {
          const parts = [
            ...ev.first.map((p) => `${POWER_LABELS[p]} +${ev.firstVP}`),
            ...ev.second.map((p) => `${POWER_LABELS[p]} +${ev.secondVP}`),
          ];
          if (parts.length) {
            sound.vp();
            pushToast({ power: ev.first[0] ?? null, title: `Spoils of ${REGIONS[ev.regionId].name}`, body: parts.join(' · ') });
          }
          break;
        }
        case 'dial_counter':
          soon(() => fx.burst(`region-${ev.regionId}`, 'aura', ev.power, 0.4));
          break;
        case 'dial_advance':
          sound.dial(ev.power);
          soon(() => fx.burst(`power-${ev.power}`, 'aura', ev.power, 0.7));
          pushToast({ power: ev.power, title: `${POWER_LABELS[ev.power]}'s dial turns`, body: ev.threat === 'victory' ? 'The final notch.' : `Threat ${ev.threat}` });
          break;
        case 'dial_vp':
        case 'provender_score':
          sound.vp();
          soon(() => fx.burst(`power-${ev.power}`, 'gold', null, 0.8));
          pushToast({ power: ev.power, title: ev.type === 'dial_vp' ? 'Dial reward' : 'Provender of Rot', vp: ev.vp });
          break;
        case 'dial_victory':
          sound.domination(ev.power);
          pushToast({ power: ev.power, title: `${POWER_LABELS[ev.power]}'s dial is complete`, big: true });
          break;
        case 'upgrade_taken': {
          const up = UPGRADE_BY_ID[ev.upgradeCardId];
          sound.domination(ev.power);
          pushToast({ power: ev.power, cardId: ev.upgradeCardId, title: `${POWER_LABELS[ev.power]} gains ${up?.name ?? 'an upgrade'}`, body: up?.effect, big: true });
          break;
        }
        case 'hero_removal':
        case 'hero_forced_removal':
          sound.kill();
          soon(() => fx.burst(`region-${ev.regionId}`, 'kill', null, 0.8));
          pushToast({ power: ev.power, title: `A hero strikes down ${oneOf(ev.power, ev.followerClass)}`, body: REGIONS[ev.regionId].name });
          break;
        case 'harvest_kill':
          sound.kill();
          soon(() => fx.burst(`region-${ev.regionId}`, 'kill', 'gormen', 0.8));
          break;
        case 'world_card_effect': {
          const text = renderText(ev);
          if (text) pushToast({ power: null, title: text });
          break;
        }
        case 'forced_discard':
          if (ev.count > 0) pushToast({ power: ev.power, title: `${POWER_LABELS[ev.power]} discards ${ev.count}`, body: ev.cardIds.map((c) => CARD_BY_ID[c]?.name ?? c).join(', ') });
          break;
        case 'game_over':
          sound.victory(ev.winners.some((w) => mine(w)));
          setGameOver({ winners: ev.winners, condition: ev.condition });
          break;
      }
    };
    return subscribe(onEvent);
  }, [subscribe, fx, sound, later, soon, pushToast]);

  // Mid-battle refresh / reconnect: close the battle scene if we left battle.
  useEffect(() => {
    if (state.phase !== 'battle' && battle && !paused) setBattle(null);
  }, [state.phase, battle, paused]);

  // A brand-new game opens with the gods awakening (once per browser session).
  useEffect(() => {
    if (!cine || state.round !== 1 || state.winners) return;
    if (state.activePowers.some((p) => state.powers[p]!.summoningTurnsTaken > 0)) return;
    const key = `ruin_intro_${state.gameId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { /* storage unavailable: just show it */ }
    setIntro(true);
    sound.phase('battle');
    const t = setTimeout(() => setIntro(false), 4200);
    return () => clearTimeout(t);
    // Only when a game first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.gameId]);

  // Also surface a game that was already over when the page loaded.
  useEffect(() => {
    if (state.winners && state.winCondition && !gameOver) {
      setGameOver({ winners: state.winners, condition: state.winCondition });
    }
    // Only on mount / when a game loads already finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.gameId]);

  const awaitingMe = !!state.pendingAction && myPowers.includes(state.pendingAction.waitingFor);
  const standings = state.activePowers
    .map((p) => ({ power: p, vp: state.powers[p]!.victoryPoints, threat: state.powers[p]!.threatValue }))
    .sort((a, b) => b.vp - a.vp);

  return (
    <div className="cin-layer">
      {battle && !paused && <BattleScene view={battle} awaitingMe={awaitingMe} />}
      {paused && aftermath.length > 0 && <Aftermath rows={aftermath} onContinue={onResume} />}
      {paused && aftermath.length === 0 && (
        <div className="cin-after"><button className="cin-btn" onClick={onResume}>Continue to Corruption</button></div>
      )}
      {intro && <IntroScene powers={state.activePowers} myPowers={myPowers} />}
      {ruin && <RuinScene regionId={ruin.regionId} ruiners={ruin.ruiners} vp={ruin.vp} />}
      {world && <WorldReveal key={world.id} cardId={world.cardId} />}
      {banner && <PhaseBanner key={banner.id} phase={banner.phase} round={banner.round} />}
      {turn && !banner && <TurnBanner key={turn.id} power={turn.power} />}
      <Toasts toasts={toasts} />
      {spell && (
        <SpellReveal
          key={spell.id}
          cardId={spell.cardId}
          power={spell.power}
          regionId={spell.regionId}
          slotIndex={spell.slotIndex}
          speed={speed}
          onDone={() => setSpell((s) => (s?.id === spell.id ? null : s))}
        />
      )}
      {gameOver && (
        <GameOverScreen
          deeds={tallyDeeds(events ?? [])}
          winners={gameOver.winners}
          condition={gameOver.condition}
          standings={standings}
          myPowers={myPowers}
          onClose={() => setGameOver(null)}
          onHome={() => navigate('/home')}
        />
      )}
    </div>
  );
}
