import { useState } from 'react';
import { POWER_COLORS, POWER_LABELS, TOKEN_LABELS } from '../lib/display.js';
import type {
  GameState,
  Power,
  Action,
  RegionId,
  FollowerInstance,
} from '@ruin/engine';
import { CARD_BY_ID, FOLLOWERS, UPGRADES, WORLD_CARD_BY_ID, UPGRADE_BY_ID, getWorldChoiceRegions, followersInRegion } from '@ruin/engine';

const REGION_LABELS: Record<RegionId, string> = {
  norrsund:    'Norrsund',
  talvimaa:    'Talvimaa',
  volensk:     'Volensk',
  mittelreich: 'Mittelreich',
  normagne:    'Normagne',
  almerida:    'Almerida',
  toscavar:    'Toscavar',
  pelascos:    'Pelascos',
  the_barrens: 'The Barrens',
};

const ALL_REGIONS: RegionId[] = [
  'norrsund', 'talvimaa', 'volensk', 'mittelreich',
  'normagne', 'almerida', 'toscavar', 'pelascos', 'the_barrens',
];

function formatId(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ActionPanelProps {
  state: GameState;
  myPower: Power;
  selectedCardId: string | null;
  onAction: (action: Action) => void;
  onActions?: (actions: Action[]) => void;
  onClearCard: () => void;
}

export default function ActionPanel({
  state,
  myPower,
  selectedCardId,
  onAction,
  onActions,
  onClearCard,
}: ActionPanelProps) {
  const pending = state.pendingAction;
  if (!pending || pending.waitingFor !== myPower) return null;

  const myState = state.powers[myPower];

  return (
    <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
      <div style={{ fontSize: '0.8rem', color: '#818cf8', fontWeight: 700, marginBottom: '0.5rem' }}>
        Your turn — {formatId(pending.actionKind)}
      </div>

      {pending.actionKind === 'summoning_action' && (
        <SummoningPanel
          state={state}
          myPower={myPower}
          selectedCardId={selectedCardId}
          onAction={onAction}
          onClearCard={onClearCard}
        />
      )}

      {pending.actionKind === 'tenzen_discard' && (
        <TenzenDiscardPanel
          hand={myState?.hand ?? []}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'world_choice' && (
        <WorldChoicePanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'tenzen_apprentice_choice' && (
        <TenzenApprenticePanel
          context={pending.context}
          onAction={onAction}
          myPower={myPower}
        />
      )}

      {pending.actionKind === 'corruption_harvest_choice' && (
        <CorruptionHarvestPanel
          state={state}
          myPower={myPower as 'gormen'}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'upgrade_choice' && (
        <UpgradeChoicePanel
          state={state}
          myPower={myPower}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'hero_removal' && (
        <HeroRemovalPanel
          state={state}
          myPower={myPower}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'world_card_effect' && (
        <WorldCardEffectPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'card_on_play_choice' && (
        <CardOnPlayChoicePanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'forced_discard' && (
        <ForcedDiscardPanel
          hand={myState?.hand ?? []}
          count={(pending.context['count'] as number | undefined) ?? 1}
          onAction={onAction}
          myPower={myPower}
        />
      )}

      {pending.actionKind === 'battle_hit_assignment' && (
        <BattleHitAssignmentPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'dial_place_token' && (
        <DialPlaceTokenPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
          onActions={onActions}
        />
      )}

      {pending.actionKind === 'dial_remove_corruption' && (
        <DialRemoveCorruptionPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
          onActions={onActions}
        />
      )}

      {pending.actionKind === 'dial_remove_world_token' && (
        <DialRemoveWorldTokenPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
          onActions={onActions}
        />
      )}
    </div>
  );
}

// ── Summoning ─────────────────────────────────────────────────────────────────

function SummoningPanel({
  state,
  myPower,
  selectedCardId,
  onAction,
  onClearCard,
}: {
  state: GameState;
  myPower: Power;
  selectedCardId: string | null;
  onAction: (action: Action) => void;
  onClearCard: () => void;
}) {
  const [mode, setMode] = useState<'summon' | 'play_card' | null>(null);
  const [selectedFollowerId, setSelectedFollowerId] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionId | null>(null);
  const [slotIndex, setSlotIndex] = useState<0 | 1>(0);

  const myState = state.powers[myPower];
  const reserveFigures = (myState?.followers ?? []).filter((f) => f.regionId === null);

  function handleSummon() {
    if (!selectedFollowerId || !selectedRegion) return;
    onAction({
      kind: 'summoning_summon_figure',
      power: myPower,
      followerId: selectedFollowerId,
      toRegion: selectedRegion,
    });
    setSelectedFollowerId(null);
    setSelectedRegion(null);
    setMode(null);
  }

  function handlePlayCard() {
    if (!selectedCardId || !selectedRegion) return;
    onAction({
      kind: 'summoning_play_card',
      power: myPower,
      cardId: selectedCardId,
      toRegion: selectedRegion,
      slotIndex,
    });
    onClearCard();
    setSelectedRegion(null);
    setMode(null);
  }

  function handlePass() {
    onAction({ kind: 'summoning_pass', power: myPower });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          className={mode === 'summon' ? 'primary' : 'secondary'}
          onClick={() => { setMode(mode === 'summon' ? null : 'summon'); setSelectedRegion(null); }}
        >
          Summon Figure
        </button>
        <button
          className={mode === 'play_card' ? 'primary' : 'secondary'}
          onClick={() => { setMode(mode === 'play_card' ? null : 'play_card'); setSelectedRegion(null); }}
          disabled={!selectedCardId}
          title={!selectedCardId ? 'Select a card from hand first' : ''}
        >
          Play Card {selectedCardId ? `(${formatId(selectedCardId)})` : ''}
        </button>
        <button className="danger" onClick={handlePass}>Pass</button>
      </div>

      {mode === 'summon' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div style={{ fontSize: '0.8rem', color: '#aaa' }}>Choose figure from reserve:</div>
          {reserveFigures.length === 0 && (
            <p style={{ color: '#f87171', fontSize: '0.8rem' }}>No figures in reserve.</p>
          )}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {reserveFigures.map((fig) => (
              <button
                key={fig.id}
                className={selectedFollowerId === fig.id ? 'primary' : 'secondary'}
                onClick={() => setSelectedFollowerId(fig.id)}
                style={{ fontSize: '0.8rem' }}
              >
                {formatId(fig.class)}
              </button>
            ))}
          </div>
          {selectedFollowerId && (
            <RegionPicker
              selectedRegion={selectedRegion}
              onSelect={setSelectedRegion}
            />
          )}
          {selectedFollowerId && selectedRegion && (
            <button className="primary" onClick={handleSummon}>
              Summon to {REGION_LABELS[selectedRegion]}
            </button>
          )}
        </div>
      )}

      {mode === 'play_card' && selectedCardId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <RegionPicker selectedRegion={selectedRegion} onSelect={setSelectedRegion} />
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', color: '#aaa' }}>Slot:</span>
            <button
              className={slotIndex === 0 ? 'primary' : 'secondary'}
              onClick={() => setSlotIndex(0)}
              style={{ minWidth: 50 }}
            >
              1
            </button>
            <button
              className={slotIndex === 1 ? 'primary' : 'secondary'}
              onClick={() => setSlotIndex(1)}
              style={{ minWidth: 50 }}
            >
              2
            </button>
          </div>
          {selectedRegion && (
            <button className="primary" onClick={handlePlayCard}>
              Play to {REGION_LABELS[selectedRegion]} (slot {slotIndex + 1})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RegionPicker({
  selectedRegion,
  onSelect,
  allowedRegions,
}: {
  selectedRegion: RegionId | null;
  onSelect: (r: RegionId) => void;
  allowedRegions?: RegionId[];
}) {
  const regions = allowedRegions ?? ALL_REGIONS;
  return (
    <div>
      <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '0.25rem' }}>Choose region:</div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {regions.map((r) => (
          <button
            key={r}
            className={selectedRegion === r ? 'primary' : 'secondary'}
            onClick={() => onSelect(r)}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Tenzen discard ────────────────────────────────────────────────────────────

function TenzenDiscardPanel({
  hand,
  onAction,
}: {
  hand: string[];
  onAction: (action: Action) => void;
}) {
  const visibleCards = hand.filter((c) => c !== '?');
  const unique = [...new Set(visibleCards)];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Choose a card to discard, or keep all:
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {unique.map((cardId) => {
          const name = CARD_BY_ID[cardId]?.shortName ?? CARD_BY_ID[cardId]?.name ?? formatId(cardId.replace(/^[a-z]+_/, ''));
          return (
            <button
              key={cardId}
              className="primary"
              onClick={() =>
                onAction({ kind: 'tenzen_discard', power: 'tenzen', cardId })
              }
              style={{ fontSize: '0.8rem' }}
            >
              Discard {name}
            </button>
          );
        })}
        <button
          className="secondary"
          onClick={() => onAction({ kind: 'tenzen_discard', power: 'tenzen', cardId: null })}
        >
          Keep all
        </button>
      </div>
    </div>
  );
}

// ── World choice ──────────────────────────────────────────────────────────────

const WORLD_TWO_REGION_CARDS = new Set(['peasant_prosperity', 'ratmen_incursion', 'chaos_storm']);

// Cards where the player picks between two fixed region pairs (A or B).
const WORLD_PAIR_CHOICES: Record<string, { ab: [string, string]; cd: [string, string] }> = {
  northern_heir:   { ab: ['Norrsund', 'Volensk'],     cd: ['Talvimaa', 'Mittelreich'] },
  heroes_of_order: { ab: ['Normagne', 'Mittelreich'],  cd: ['Almerida', 'Toscavar'] },
};

function WorldChoicePanel({
  state,
  myPower,
  context,
  onAction,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const [selectedRegion, setSelectedRegion] = useState<RegionId | null>(null);
  const [selectedRegions, setSelectedRegions] = useState<RegionId[]>([]);
  const cardId = (context['cardId'] as string | undefined) ?? '';

  const cardDef = cardId ? WORLD_CARD_BY_ID[cardId] : undefined;
  const allowedRegions = cardId ? getWorldChoiceRegions(state, cardId) : undefined;
  const isTwoRegion = WORLD_TWO_REGION_CARDS.has(cardId);
  const pairChoice = WORLD_PAIR_CHOICES[cardId];

  function toggleRegion(r: RegionId) {
    setSelectedRegions(prev => {
      if (prev.includes(r)) return prev.filter(x => x !== r);
      if (prev.length >= 2) return prev;
      return [...prev, r];
    });
  }

  function handleSubmit() {
    if (isTwoRegion) {
      if (selectedRegions.length === 0) return;
      onAction({ kind: 'world_choice', power: myPower, cardId, choices: { regions: selectedRegions } });
    } else {
      if (!selectedRegion) return;
      onAction({ kind: 'world_choice', power: myPower, cardId, choices: { regionId: selectedRegion } });
    }
  }

  const regions = allowedRegions ?? ALL_REGIONS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {cardDef && (
        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0' }}>
          {cardDef.name}
        </div>
      )}
      {cardDef?.immediateEffect && (
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontStyle: 'italic' }}>
          {cardDef.immediateEffect}
        </div>
      )}
      {cardDef?.persistentEffect && (
        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
          Persistent: {cardDef.persistentEffect}
        </div>
      )}
      {pairChoice ? (
        <>
          <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '0.25rem' }}>
            Choose one:
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
            {(['ab', 'cd'] as const).map(pair => {
              const [r1, r2] = pairChoice[pair];
              return (
                <button
                  key={pair}
                  className="primary"
                  onClick={() => onAction({ kind: 'world_choice', power: myPower, cardId, choices: { pair } })}
                  style={{
                    background: '#1e1e3a',
                    border: '2px solid #3a3a6e',
                    borderRadius: 5,
                    padding: '0.5rem 0.75rem',
                    color: '#ddd',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {r1} &amp; {r2}
                </button>
              );
            })}
          </div>
        </>
      ) : (
      <>
      {isTwoRegion && (
        <div style={{ fontSize: '0.8rem', color: '#aaa', marginTop: '0.25rem' }}>
          Choose up to 2 regions:
        </div>
      )}
      {isTwoRegion ? (
        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
          {regions.map(r => {
            const sel = selectedRegions.includes(r);
            const disabled = !sel && selectedRegions.length >= 2;
            return (
              <button
                key={r}
                onClick={() => toggleRegion(r)}
                disabled={disabled}
                style={{
                  background: sel ? '#312e81' : '#1e1e3a',
                  border: `2px solid ${sel ? '#818cf8' : '#3a3a6e'}`,
                  borderRadius: 5,
                  padding: '0.3rem 0.5rem',
                  color: sel ? '#c4b5fd' : disabled ? '#555' : '#ddd',
                  fontSize: '0.8rem',
                  cursor: disabled ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {REGION_LABELS[r]}
              </button>
            );
          })}
        </div>
      ) : (
        <RegionPicker selectedRegion={selectedRegion} onSelect={setSelectedRegion} allowedRegions={allowedRegions} />
      )}
      {(isTwoRegion ? selectedRegions.length > 0 : selectedRegion) && (
        <button className="primary" onClick={handleSubmit}>
          Confirm{isTwoRegion
            ? `: ${selectedRegions.map(r => REGION_LABELS[r]).join(', ')}`
            : `: ${REGION_LABELS[selectedRegion!]}`}
        </button>
      )}
      </>
      )}
    </div>
  );
}

// ── Tenzen Apprentice choice ──────────────────────────────────────────────────

function TenzenApprenticePanel({
  context,
  onAction,
  myPower,
}: {
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
  myPower: Power;
}) {
  const followerId = context['followerId'] as string;
  const fromRegion = context['fromRegion'] as RegionId;
  const toRegion = context['toRegion'] as RegionId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Carry the Chaos Stone from {REGION_LABELS[fromRegion]} to {REGION_LABELS[toRegion]}?
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className="primary"
          onClick={() => onAction({ kind: 'tenzen_apprentice_choice', power: myPower, followerId, fromRegion, toRegion, carry: true })}
          style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem' }}
        >
          Carry
        </button>
        <button
          className="secondary"
          onClick={() => onAction({ kind: 'tenzen_apprentice_choice', power: myPower, followerId, fromRegion, toRegion, carry: false })}
          style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem' }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

// ── Corruption harvest ────────────────────────────────────────────────────────

function CorruptionHarvestPanel({
  state,
  myPower,
  context,
  onAction,
}: {
  state: GameState;
  myPower: 'gormen';
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const regionId = (context['regionId'] as RegionId | undefined);
  const maxKills = (context['maxKills'] as number | undefined) ?? 1;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (!regionId) return <p style={{ color: '#f87171' }}>Missing region in context.</p>;
  const safeRegionId: RegionId = regionId;

  const enemyFigures = followersInRegion(state, safeRegionId).filter(
    (f) => (f.controlledBy ?? f.power) !== myPower && (f.class === 'cultist' || f.class === 'warrior') && !f.tipped,
  );
  // Must kill exactly this many
  const required = Math.min(maxKills, enemyFigures.length);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < required) {
        next.add(id);
      }
      return next;
    });
  }

  function handleSubmit() {
    onAction({
      kind: 'corruption_harvest_choice',
      power: 'gormen',
      regionId: safeRegionId,
      followerIds: Array.from(selected),
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Choose {required} figure(s) to kill in {REGION_LABELS[regionId]}:
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {enemyFigures.map((fig) => (
          <button
            key={fig.id}
            className={selected.has(fig.id) ? 'danger' : 'secondary'}
            onClick={() => toggle(fig.id)}
            style={{ fontSize: '0.8rem' }}
          >
            {formatId(fig.power)} {formatId(fig.class)}
          </button>
        ))}
      </div>
      {selected.size === required && (
        <button className="primary" onClick={handleSubmit}>
          Confirm kills
        </button>
      )}
    </div>
  );
}

// ── Upgrade choice ────────────────────────────────────────────────────────────

function UpgradeChoicePanel({
  state,
  myPower,
  onAction,
}: {
  state: GameState;
  myPower: Power;
  onAction: (action: Action) => void;
}) {
  const myState = state.powers[myPower];
  const upgrades = myState?.availableUpgradeIds ?? [];

  if (upgrades.length === 0) {
    return <p style={{ color: '#aaa', fontSize: '0.8rem' }}>No upgrades available.</p>;
  }

  const powerColor = POWER_COLORS[myPower];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>Choose an upgrade:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {upgrades.map((upgradeId) => {
          const def = UPGRADE_BY_ID[upgradeId];
          return (
            <button
              key={upgradeId}
              onClick={() =>
                onAction({ kind: 'upgrade_choice', power: myPower, upgradeCardId: upgradeId })
              }
              style={{
                textAlign: 'left', padding: '0.4rem 0.6rem',
                background: 'transparent',
                border: `2px solid ${powerColor}`,
                borderRadius: 6, cursor: 'pointer', width: '100%',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '0.85rem', color: powerColor }}>
                {def?.name ?? formatId(upgradeId)}
              </div>
              {def?.effect && (
                <div style={{ fontWeight: 400, fontSize: '0.75rem', color: '#d1d5db', marginTop: '0.15rem' }}>
                  {def.effect}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Hero removal ──────────────────────────────────────────────────────────────

function HeroRemovalPanel({
  state,
  myPower,
  onAction,
}: {
  state: GameState;
  myPower: Power;
  onAction: (action: Action) => void;
}) {
  const myState = state.powers[myPower];
  const onBoardFigures = (myState?.followers ?? []).filter((f) => f.regionId !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Choose a figure to remove (Hero token effect):
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {onBoardFigures.map((fig) => (
          <button
            key={fig.id}
            className="danger"
            onClick={() =>
              onAction({
                kind: 'hero_removal',
                power: myPower,
                followerId: fig.id,
                regionId: fig.regionId!,
              })
            }
            style={{ fontSize: '0.8rem' }}
          >
            {formatId(fig.class)} in {fig.regionId ? REGION_LABELS[fig.regionId] : '?'}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Card on-play choice ───────────────────────────────────────────────────────

const POWER_LABELS_LOCAL: Record<string, string> = {
  xarm: 'Xarm', gormen: 'Gormen', tenzen: 'Tenzen', lasha: 'Lasha',
};

export function CardOnPlayChoicePanel({
  state,
  myPower,
  context,
  onAction,
  onUndo,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
  onUndo?: () => void;
}) {
  const cardId   = (context['cardId']   as string   | undefined) ?? '';
  const regionId = (context['regionId'] as RegionId | undefined);

  function submit(choices: Record<string, unknown>) {
    if (!regionId) return;
    onAction({ kind: 'card_on_play_choice', power: myPower, cardId, regionId, choices });
  }

  const cardTitle = formatId(cardId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#a78bfa', fontWeight: 600 }}>
        {cardTitle}
      </div>

      {cardId === 'tenzen_the_meddling_of_rats' && regionId && (
        <StolenThoughtsPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'lasha_hidden_influence' && regionId && (
        <InvisibleHandPanel state={state} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'xarm_call_to_war' && regionId && (
        <WarMarchPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'tenzen_teleport' && regionId && (
        <PhaseShiftPanel state={state} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'tenzen_fate_shield' && regionId && (
        <FatesAegisPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'lasha_narcotic_musk' && regionId && (
        <EnthrallmentPanel state={state} regionId={regionId} onSubmit={submit} />
      )}

      {onUndo && (
        <button className="secondary" onClick={onUndo} style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
          Undo
        </button>
      )}
    </div>
  );
}

// ── Meddling of Rats: choose opponent to discard 2 cards ───────────────────────

function StolenThoughtsPanel({
  state, myPower, regionId, onSubmit,
}: {
  state: GameState; myPower: Power; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const region = state.regions[regionId];
  const eligiblePowers = state.activePowers.filter(p =>
    p !== myPower &&
    followersInRegion(state, regionId).some(f => (f.controlledBy ?? f.power) === p) &&
    (state.powers[p]?.hand.length ?? 0) > 0
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        Choose opponent to discard 2 cards:
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {eligiblePowers.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No eligible opponents.</span>
        )}
        {eligiblePowers.map(p => (
          <button key={p} className="danger"
            onClick={() => onSubmit({ targetPower: p })}
            style={{ fontSize: '0.8rem' }}
          >
            {POWER_LABELS_LOCAL[p] ?? p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Invisible Hand: choose token + destination ────────────────────────────────

function InvisibleHandPanel({
  state, regionId, onSubmit,
}: {
  state: GameState; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const [chosenToken, setChosenToken] = useState<string | null>(null);
  const [chosenRegion, setChosenRegion] = useState<RegionId | null>(null);

  const TOKEN_TYPES = ['peasant', 'hero', 'noble'] as const;
  const sourceTokens = TOKEN_TYPES.filter(t => (state.regions[regionId]?.tokens ?? []).includes(t));
  const validDests = ALL_REGIONS.filter(r => r !== regionId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        Move a token from {REGION_LABELS[regionId]}:
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {sourceTokens.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No tokens here.</span>}
        {sourceTokens.map(t => (
          <button key={t} className={chosenToken === t ? 'primary' : 'secondary'}
            onClick={() => { setChosenToken(t); setChosenRegion(null); }}
            style={{ fontSize: '0.8rem' }}
          >{TOKEN_LABELS[t]}</button>
        ))}
      </div>
      {chosenToken && (
        <>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Destination:</div>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {validDests.map(r => (
              <button key={r} className={chosenRegion === r ? 'primary' : 'secondary'}
                onClick={() => setChosenRegion(r)}
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
              >{REGION_LABELS[r]}</button>
            ))}
          </div>
          {chosenRegion && (
            <button className="primary"
              onClick={() => onSubmit({ token: chosenToken, fromRegion: regionId, toRegion: chosenRegion })}
              style={{ fontSize: '0.8rem' }}
            >
              Move {TOKEN_LABELS[chosenToken as keyof typeof TOKEN_LABELS] ?? chosenToken} → {REGION_LABELS[chosenRegion]}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── War March: choose up to 2 own figures from other regions ──────────────────

function WarMarchPanel({
  state, myPower, regionId, onSubmit,
}: {
  state: GameState; myPower: Power; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const moveable = (state.powers[myPower]?.followers ?? []).filter(
    f => f.regionId !== null && f.regionId !== regionId
  );

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else if (next.size < 2) { next.add(id); }
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        Choose up to 2 figures to move here (selected: {selected.size}):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {moveable.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No figures to move.</span>}
        {moveable.map(f => (
          <button key={f.id} className={selected.has(f.id) ? 'primary' : 'secondary'}
            onClick={() => toggle(f.id)}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {formatId(f.class)} in {f.regionId ? REGION_LABELS[f.regionId] : '?'}
          </button>
        ))}
      </div>
      {selected.size > 0 && (
        <button className="primary"
          onClick={() => onSubmit({ followerIds: Array.from(selected) })}
          style={{ fontSize: '0.8rem' }}
        >
          Move {selected.size} figure{selected.size > 1 ? 's' : ''} here
        </button>
      )}
    </div>
  );
}

// ── Phase Shift: choose cultist or warrior in region + destination ─────────────

function PhaseShiftPanel({
  state, regionId, onSubmit,
}: {
  state: GameState; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const [chosenFig, setChosenFig] = useState<string | null>(null);
  const [chosenRegion, setChosenRegion] = useState<RegionId | null>(null);
  const [carry, setCarry] = useState(false);

  const moveable = followersInRegion(state, regionId).filter(
    f => f.class === 'cultist' || f.class === 'warrior'
  );
  const validDests = ALL_REGIONS.filter(r => r !== regionId);

  // Show carry option when teleporting a tenzen cultist from a chaos-stone region with apprentices
  const selectedFig = chosenFig ? moveable.find(f => f.id === chosenFig) : null;
  const canCarry = selectedFig !== null && selectedFig !== undefined &&
    selectedFig.power === 'tenzen' && selectedFig.class === 'cultist' &&
    state.powers['tenzen']?.upgradesInPlay.includes('tenzen_apprentices_up') &&
    state.regions[regionId]!.tokens.includes('chaos_stone');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Choose figure to move:</div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {moveable.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No eligible figures.</span>}
        {moveable.map(f => (
          <button key={f.id} className={chosenFig === f.id ? 'primary' : 'secondary'}
            onClick={() => { setChosenFig(f.id); setChosenRegion(null); setCarry(false); }}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {POWER_LABELS_LOCAL[f.power] ?? f.power} {formatId(f.class)}
          </button>
        ))}
      </div>
      {chosenFig && (
        <>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Destination:</div>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {validDests.map(r => (
              <button key={r} className={chosenRegion === r ? 'primary' : 'secondary'}
                onClick={() => setChosenRegion(r)}
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
              >{REGION_LABELS[r]}</button>
            ))}
          </div>
          {canCarry && (
            <label style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={carry} onChange={e => setCarry(e.target.checked)} />
              Carry Chaos Stone
            </label>
          )}
          {chosenRegion && (
            <button className="primary"
              onClick={() => onSubmit({ followerId: chosenFig, toRegion: chosenRegion, ...(canCarry ? { carry } : {}) })}
              style={{ fontSize: '0.8rem' }}
            >
              Move → {REGION_LABELS[chosenRegion]}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Fate's Aegis: choose one of your figures to protect ──────────────────────

function FatesAegisPanel({
  state, myPower, regionId, onSubmit,
}: {
  state: GameState; myPower: Power; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const figures = followersInRegion(state, regionId, myPower);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        Choose a figure to protect this battle:
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {figures.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No figures here.</span>}
        {figures.map(f => (
          <button key={f.id} className="primary"
            onClick={() => onSubmit({ followerId: f.id })}
            style={{ fontSize: '0.8rem' }}
          >
            {formatId(f.class)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Enthrallment: choose an enemy cultist to control ─────────────────────────

function EnthrallmentPanel({
  state, regionId, onSubmit,
}: {
  state: GameState; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const targets = followersInRegion(state, regionId).filter(
    f => f.class === 'cultist' && (f.controlledBy ?? f.power) !== 'lasha'
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
        Choose an enemy cultist to control:
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {targets.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No eligible cultists.</span>}
        {targets.map(f => (
          <button key={f.id} className="primary"
            onClick={() => onSubmit({ followerId: f.id })}
            style={{ fontSize: '0.8rem' }}
          >
            {POWER_LABELS_LOCAL[f.power] ?? f.power} Cultist
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Forced discard (Meddling of Rats deferred) ─────────────────────────────────

function ForcedDiscardPanel({
  hand,
  count,
  onAction,
  myPower,
}: {
  hand: string[];
  count: number;
  onAction: (action: Action) => void;
  myPower: Power;
}) {
  // Track by index to handle duplicate card IDs correctly
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const visibleEntries = hand
    .map((cardId, i) => ({ cardId, i }))
    .filter(e => e.cardId !== '?');

  function toggle(idx: number) {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else if (next.size < count) {
        next.add(idx);
      }
      return next;
    });
  }

  function handleConfirm() {
    const cardIds = Array.from(selectedIndices).map(i => hand[i]!);
    onAction({ kind: 'forced_discard', power: myPower, cardIds });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#f87171' }}>
        Meddling of Rats — choose {count} card{count !== 1 ? 's' : ''} to discard ({selectedIndices.size}/{count} selected):
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {visibleEntries.map(({ cardId, i }) => (
          <button
            key={i}
            className={selectedIndices.has(i) ? 'danger' : 'secondary'}
            onClick={() => toggle(i)}
            style={{ fontSize: '0.8rem' }}
          >
            {formatId(cardId)}
          </button>
        ))}
      </div>
      {selectedIndices.size === count && (
        <button className="danger" onClick={handleConfirm}>
          Discard {count} card{count !== 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

// ── Battle hit assignment ─────────────────────────────────────────────────────

function BattleHitAssignmentPanel({
  state,
  myPower,
  context,
  onAction,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedPeasants, setSelectedPeasants] = useState(0);

  const regionId = context['regionId'] as RegionId | undefined;
  const hitsRemaining = (context['hitsRemaining'] as number | undefined) ?? 0;
  const peasantsAvailable = (context['peasantsAvailable'] as number | undefined) ?? 0;
  if (!regionId) return null;
  const safeRegionId: RegionId = regionId;

  const region = state.regions[safeRegionId]!;
  const CLASS_ORDER: Record<string, number> = { cultist: 0, warrior: 1, incarnation: 2 };
  const targets = followersInRegion(state, safeRegionId)
    .filter(f => {
      const ctrl = f.controlledBy ?? f.power;
      return ctrl !== myPower && !f.tipped && !f.protected;
    })
    .sort((a, b) => {
      const pa = (a.controlledBy ?? a.power) as string;
      const pb = (b.controlledBy ?? b.power) as string;
      if (pa !== pb) return pa.localeCompare(pb);
      return (CLASS_ORDER[a.class] ?? 0) - (CLASS_ORDER[b.class] ?? 0);
    });

  function getDefense(fig: FollowerInstance): number {
    const owner = fig.power as Power;
    const def = FOLLOWERS[owner]?.[fig.class];
    if (!def) return 1;
    const isUpgraded = state.powers[owner]!.upgradesInPlay.some(u =>
      UPGRADES.find(up => up.id === u)?.upgradeType === fig.class
    );
    let d = isUpgraded ? def.upgraded.defense : def.base.defense;

    const regionCards = state.regions[safeRegionId]!.chaosCards;
    const rottingGrasp = regionCards.some(c => c?.cardId === 'gormen_pestilent_touch');
    const blightWard   = regionCards.some(c => c?.cardId === 'gormen_rain_of_bile');
    const nullWeave    = regionCards.some(c => c?.cardId === 'tenzen_changer_of_fate');

    if (!nullWeave) {
      if (blightWard   && (fig.controlledBy ?? fig.power) === 'gormen') d += 1;
      if (rottingGrasp && (fig.controlledBy ?? fig.power) !== 'gormen') d = Math.max(1, d - 1);
    }

    return d;
  }

  const figureHitsUsed = Array.from(selectedIds).reduce((sum, fid) => {
    const f = targets.find(t => t.id === fid);
    return sum + (f ? getDefense(f) : 0);
  }, 0);
  const totalHitsUsed = figureHitsUsed + selectedPeasants;
  const hitsLeft = hitsRemaining - totalHitsUsed;

  function toggleFigure(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const cost = getDefense(targets.find(t => t.id === id)!);
        if (cost <= hitsLeft) next.add(id);
      }
      return next;
    });
  }

  function handleConfirm() {
    onAction({
      kind: 'battle_hit_assignment',
      power: myPower,
      regionId: safeRegionId,
      followerIds: Array.from(selectedIds),
      peasantsToTake: selectedPeasants,
    });
    setSelectedIds(new Set());
    setSelectedPeasants(0);
  }

  const kills = selectedIds.size;
  const canKillMore = targets.some(f => !selectedIds.has(f.id) && getDefense(f) <= hitsLeft);
  const canClaimMore = selectedPeasants < peasantsAvailable && hitsLeft >= 1;
  const confirmDisabled = hitsLeft > 0 && (canKillMore || canClaimMore);
  const confirmLabel = kills === 0 && selectedPeasants === 0
    ? 'Apply hits (no kills)'
    : [
        kills > 0 ? `Kill ${kills} figure${kills > 1 ? 's' : ''}` : '',
        selectedPeasants > 0 ? `Claim ${selectedPeasants} peasant${selectedPeasants > 1 ? 's' : ''}` : '',
      ].filter(Boolean).join(' + ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#f87171' }}>
        Battle in {REGION_LABELS[safeRegionId]} — {hitsRemaining} hit(s) to assign
        ({totalHitsUsed}/{hitsRemaining} used):
      </div>
      {peasantsAvailable > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#fbbf24' }}>Peasants ({peasantsAvailable}):</span>
          <button
            className="secondary"
            style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem' }}
            disabled={selectedPeasants === 0}
            onClick={() => setSelectedPeasants(p => Math.max(0, p - 1))}
          >−</button>
          <span style={{ fontSize: '0.8rem', minWidth: 16, textAlign: 'center' }}>{selectedPeasants}</span>
          <button
            className="secondary"
            style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem' }}
            disabled={selectedPeasants >= peasantsAvailable || hitsLeft <= 0}
            onClick={() => setSelectedPeasants(p => p + 1)}
          >+</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {targets.length === 0 && peasantsAvailable === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No valid targets.</span>
        )}
        {targets.map(f => (
          <button
            key={f.id}
            className={selectedIds.has(f.id) ? 'danger' : 'secondary'}
            onClick={() => toggleFigure(f.id)}
            style={{ fontSize: '0.8rem' }}
            disabled={!selectedIds.has(f.id) && getDefense(f) > hitsLeft}
          >
            {POWER_LABELS_LOCAL[f.controlledBy ?? f.power] ?? f.power} {formatId(f.class)}
            <span style={{ color: '#94a3b8', marginLeft: 4 }}>def {getDefense(f)}</span>
          </button>
        ))}
      </div>
      <button className="danger" onClick={handleConfirm} disabled={confirmDisabled}>
        {confirmLabel}
      </button>
    </div>
  );
}

// ── World card effect ─────────────────────────────────────────────────────────

function WorldCardEffectPanel({
  state,
  myPower,
  context,
  onAction,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const [selectedRegion, setSelectedRegion] = useState<RegionId | null>(null);
  const cardId = (context['cardId'] as string | undefined) ?? '';

  function handleSubmit() {
    if (!selectedRegion) return;
    onAction({
      kind: 'world_card_effect',
      power: myPower,
      cardId,
      choices: { regionId: selectedRegion },
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        World card effect {cardId ? `(${formatId(cardId)})` : ''} — choose a region:
      </div>
      <RegionPicker selectedRegion={selectedRegion} onSelect={setSelectedRegion} />
      {selectedRegion && (
        <button className="primary" onClick={handleSubmit}>
          Confirm: {REGION_LABELS[selectedRegion]}
        </button>
      )}
    </div>
  );
}

// ── Dial: place token ─────────────────────────────────────────────────────────

function DialPlaceTokenPanel({
  state,
  myPower,
  context,
  onAction,
  onActions,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
  onActions?: (actions: Action[]) => void;
}) {
  const tokenType = (context['tokenType'] as string) ?? 'noble';
  const tokenLabel = TOKEN_LABELS[tokenType as keyof typeof TOKEN_LABELS] ?? tokenType;
  const remaining = (context['remaining'] as number) ?? 1;
  const count = (context['count'] as number) ?? remaining;
  const [picks, setPicks] = useState<RegionId[]>([]);

  const validRegions = ALL_REGIONS.filter(r => state.regions[r]!.ruinationCardIndex === null);

  function addPick(r: RegionId) {
    if (picks.length >= remaining) return;
    setPicks(prev => [...prev, r]);
  }
  function removePick(i: number) {
    setPicks(prev => prev.filter((_, idx) => idx !== i));
  }
  function confirm() {
    const actions: Action[] = picks.map(r => ({ kind: 'dial_place_token', power: myPower, regionId: r }));
    if (onActions) onActions(actions);
    else for (const a of actions) onAction(a);
    setPicks([]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — place <strong style={{ color: '#facc15' }}>{tokenLabel}</strong> token(s)
        ({remaining} of {count} remaining):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {validRegions.map(r => (
          <button
            key={r}
            className="secondary"
            onClick={() => addPick(r)}
            disabled={picks.length >= remaining}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>
      {picks.length > 0 && (
        <div style={{ fontSize: '0.75rem', color: '#d4d4d8' }}>
          Selected: {picks.map((r, i) => (
            <button
              key={i}
              className="secondary"
              onClick={() => removePick(i)}
              style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', marginLeft: 4 }}
              title="Click to remove"
            >
              {REGION_LABELS[r]} ×
            </button>
          ))}
        </div>
      )}
      {picks.length > 0 && (
        <button
          className="primary"
          onClick={confirm}
          disabled={picks.length !== remaining}
          style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '0.4rem 1rem' }}
        >
          Confirm ({picks.length}/{remaining})
        </button>
      )}
    </div>
  );
}

// ── Dial: remove corruption ───────────────────────────────────────────────────

function DialRemoveCorruptionPanel({
  state,
  myPower,
  context,
  onAction,
  onActions,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
  onActions?: (actions: Action[]) => void;
}) {
  const remaining = (context['remaining'] as number) ?? 1;
  const count = (context['count'] as number) ?? remaining;
  const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
  type Pick = { regionId: RegionId; targetPower: Power };
  const [picks, setPicks] = useState<Pick[]>([]);

  // Enumerate every (region, power) combination with at least one corruption token
  const candidates: Array<{ regionId: typeof ALL_REGIONS[number]; targetPower: Power; count: number }> = [];
  for (const r of ALL_REGIONS) {
    for (const tp of POWERS) {
      const c = state.regions[r]!.corruptionTokens[tp] ?? 0;
      if (c > 0) candidates.push({ regionId: r, targetPower: tp, count: c });
    }
  }

  // Available = base supply minus what's already picked for (region, targetPower)
  function availableFor(regionId: RegionId, targetPower: Power): number {
    const base = state.regions[regionId]!.corruptionTokens[targetPower] ?? 0;
    const taken = picks.filter(p => p.regionId === regionId && p.targetPower === targetPower).length;
    return base - taken;
  }

  function addPick(p: Pick) {
    if (picks.length >= remaining) return;
    if (availableFor(p.regionId, p.targetPower) <= 0) return;
    setPicks(prev => [...prev, p]);
  }
  function removePick(i: number) {
    setPicks(prev => prev.filter((_, idx) => idx !== i));
  }
  function confirm() {
    const actions: Action[] = picks.map(p => ({
      kind: 'dial_remove_corruption', power: myPower, regionId: p.regionId, targetPower: p.targetPower,
    }));
    if (onActions) onActions(actions);
    else for (const a of actions) onAction(a);
    setPicks([]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — remove corruption ({remaining} of {count} remaining):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {candidates.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No corruption to remove.</span>
        )}
        {candidates.map(({ regionId, targetPower }) => {
          const avail = availableFor(regionId, targetPower);
          return (
            <button
              key={`${regionId}-${targetPower}`}
              className="secondary"
              onClick={() => addPick({ regionId, targetPower })}
              disabled={avail <= 0 || picks.length >= remaining}
              style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
            >
              {REGION_LABELS[regionId]}{' '}
              <span style={{ color: POWER_COLORS[targetPower], fontWeight: 600 }}>
                {POWER_LABELS[targetPower]}
              </span>{' '}
              ({avail})
            </button>
          );
        })}
      </div>
      {picks.length > 0 && (
        <div style={{ fontSize: '0.75rem', color: '#d4d4d8' }}>
          Selected: {picks.map((p, i) => (
            <button
              key={i}
              className="secondary"
              onClick={() => removePick(i)}
              style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', marginLeft: 4 }}
              title="Click to remove"
            >
              {REGION_LABELS[p.regionId]}{' '}
              <span style={{ color: POWER_COLORS[p.targetPower], fontWeight: 600 }}>
                {POWER_LABELS[p.targetPower]}
              </span>{' '}
              ×
            </button>
          ))}
        </div>
      )}
      {picks.length > 0 && (
        <button
          className="primary"
          onClick={confirm}
          disabled={picks.length !== remaining}
          style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '0.4rem 1rem' }}
        >
          Confirm ({picks.length}/{remaining})
        </button>
      )}
    </div>
  );
}

// ── Dial: remove world token ──────────────────────────────────────────────────

function DialRemoveWorldTokenPanel({
  state,
  myPower,
  context,
  onAction,
  onActions,
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
  onActions?: (actions: Action[]) => void;
}) {
  const remaining = (context['remaining'] as number) ?? 1;
  type RemovableToken = 'event' | 'hero' | 'noble' | 'peasant' | 'ratmen';
  const TOKEN_NAMES: Record<RemovableToken, string> = {
    event: TOKEN_LABELS.event,
    hero: TOKEN_LABELS.hero,
    noble: TOKEN_LABELS.noble,
    peasant: TOKEN_LABELS.peasant,
    ratmen: TOKEN_LABELS.ratmen,
  };

  type Selection = { regionId: RegionId; tokenType: RemovableToken };
  const [selected, setSelected] = useState<Selection[]>([]);

  // Collect (region, tokenType) pairs
  const options: Selection[] = [];
  for (const regionId of ALL_REGIONS) {
    const seen = new Set<string>();
    for (const t of state.regions[regionId]!.tokens) {
      if (t === 'chaos_stone') continue;
      if (seen.has(t)) continue;
      seen.add(t);
      options.push({ regionId, tokenType: t as RemovableToken });
    }
  }

  function toggleOption(opt: Selection) {
    setSelected(prev => {
      const key = `${opt.regionId}-${opt.tokenType}`;
      const exists = prev.some(s => `${s.regionId}-${s.tokenType}` === key);
      if (exists) return prev.filter(s => `${s.regionId}-${s.tokenType}` !== key);
      if (prev.length >= remaining) return prev;
      return [...prev, opt];
    });
  }

  function isSelected(opt: Selection) {
    return selected.some(s => s.regionId === opt.regionId && s.tokenType === opt.tokenType);
  }

  function handleConfirm() {
    const actions: Action[] = selected.map(s => ({
      kind: 'dial_remove_world_token',
      power: myPower,
      regionId: s.regionId,
      tokenType: s.tokenType,
    }));
    if (onActions) onActions(actions);
    else for (const a of actions) onAction(a);
    setSelected([]);
  }

  // Single removal — no multi-select needed
  if (remaining === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
          Dial reward — remove a world token:
        </div>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          {options.length === 0 && (
            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No tokens to remove.</span>
          )}
          {options.map(({ regionId, tokenType }) => (
            <button
              key={`${regionId}-${tokenType}`}
              className="secondary"
              onClick={() => onAction({ kind: 'dial_remove_world_token', power: myPower, regionId, tokenType })}
              style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
            >
              {TOKEN_NAMES[tokenType]} from {REGION_LABELS[regionId]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — remove {remaining} world tokens (select {remaining}):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {options.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No tokens to remove.</span>
        )}
        {options.map(({ regionId, tokenType }) => {
          const sel = isSelected({ regionId, tokenType });
          return (
            <button
              key={`${regionId}-${tokenType}`}
              className={sel ? 'primary' : 'secondary'}
              onClick={() => toggleOption({ regionId, tokenType })}
              style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
            >
              {TOKEN_NAMES[tokenType]} from {REGION_LABELS[regionId]}
            </button>
          );
        })}
      </div>
      {selected.length > 0 && (
        <button
          className="primary"
          onClick={handleConfirm}
          disabled={selected.length !== remaining}
          style={{ alignSelf: 'flex-start', fontSize: '0.8rem', padding: '0.4rem 1rem' }}
        >
          Confirm ({selected.length}/{remaining})
        </button>
      )}
    </div>
  );
}
