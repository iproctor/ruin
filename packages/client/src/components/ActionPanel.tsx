import { useState } from 'react';
import type {
  GameState,
  Power,
  Action,
  RegionId,
  FollowerInstance,
} from '@ruin/engine';
import { FOLLOWERS, UPGRADES } from '@ruin/engine';

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
  onClearCard: () => void;
}

export default function ActionPanel({
  state,
  myPower,
  selectedCardId,
  onAction,
  onClearCard,
}: ActionPanelProps) {
  const pending = state.pendingAction;
  if (!pending || pending.waitingFor !== myPower) return null;

  const myState = state.powers[myPower];

  return (
    <div
      style={{
        background: '#16213e',
        border: '2px solid #312e81',
        borderRadius: 8,
        padding: '0.75rem',
      }}
    >
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
        />
      )}

      {pending.actionKind === 'dial_remove_corruption' && (
        <DialRemoveCorruptionPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
        />
      )}

      {pending.actionKind === 'dial_remove_world_token' && (
        <DialRemoveWorldTokenPanel
          state={state}
          myPower={myPower}
          context={pending.context}
          onAction={onAction}
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
}: {
  selectedRegion: RegionId | null;
  onSelect: (r: RegionId) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: '0.25rem' }}>Choose region:</div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {ALL_REGIONS.map((r) => (
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Choose a card to discard, or keep all:
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {visibleCards.map((cardId) => (
          <button
            key={cardId}
            className="danger"
            onClick={() =>
              onAction({ kind: 'tenzen_discard', power: 'tenzen', cardId })
            }
            style={{ fontSize: '0.8rem' }}
          >
            Discard {formatId(cardId)}
          </button>
        ))}
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
  const cardId = (context['cardId'] as string | undefined) ?? '';

  function handleSubmit() {
    if (!selectedRegion) return;
    onAction({
      kind: 'world_choice',
      power: myPower,
      cardId,
      choices: { regionId: selectedRegion },
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        World card {cardId ? formatId(cardId) : ''} — choose a region:
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
  const required = (context['count'] as number | undefined) ?? 1;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (!regionId) return <p style={{ color: '#f87171' }}>Missing region in context.</p>;
  const safeRegionId: RegionId = regionId;

  const region = state.regions[safeRegionId];
  const enemyFigures = (region?.placements ?? []).filter((f) => f.power !== myPower);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>Choose an upgrade:</div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {upgrades.map((upgradeId) => (
          <button
            key={upgradeId}
            className="primary"
            onClick={() =>
              onAction({ kind: 'upgrade_choice', power: myPower, upgradeCardId: upgradeId })
            }
          >
            {formatId(upgradeId)}
          </button>
        ))}
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

      {cardId === 'tenzen_stolen_thoughts' && regionId && (
        <StolenThoughtsPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'lasha_invisible_hand' && regionId && (
        <InvisibleHandPanel state={state} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'xarm_war_march' && regionId && (
        <WarMarchPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'tenzen_phase_shift' && regionId && (
        <PhaseShiftPanel state={state} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'tenzen_fates_aegis' && regionId && (
        <FatesAegisPanel state={state} myPower={myPower} regionId={regionId} onSubmit={submit} />
      )}
      {cardId === 'lasha_enthrallment' && regionId && (
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

// ── Stolen Thoughts: choose opponent to discard 2 cards ───────────────────────

function StolenThoughtsPanel({
  state, myPower, regionId, onSubmit,
}: {
  state: GameState; myPower: Power; regionId: RegionId;
  onSubmit: (choices: Record<string, unknown>) => void;
}) {
  const region = state.regions[regionId];
  const eligiblePowers = state.activePowers.filter(p =>
    p !== myPower &&
    (region?.placements ?? []).some(f => (f.controlledBy ?? f.power) === p) &&
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
            style={{ fontSize: '0.8rem', textTransform: 'capitalize' }}
          >{t}</button>
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
              Move {chosenToken} → {REGION_LABELS[chosenRegion]}
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

  const moveable = state.powers[myPower]!.followers.filter(
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

  const moveable = (state.regions[regionId]?.placements ?? []).filter(
    f => f.class === 'cultist' || f.class === 'warrior'
  );
  const validDests = ALL_REGIONS.filter(r => r !== regionId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Choose figure to move:</div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {moveable.length === 0 && <span style={{ fontSize: '0.75rem', color: '#f87171' }}>No eligible figures.</span>}
        {moveable.map(f => (
          <button key={f.id} className={chosenFig === f.id ? 'primary' : 'secondary'}
            onClick={() => { setChosenFig(f.id); setChosenRegion(null); }}
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
          {chosenRegion && (
            <button className="primary"
              onClick={() => onSubmit({ followerId: chosenFig, toRegion: chosenRegion })}
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
  const figures = (state.regions[regionId]?.placements ?? []).filter(
    f => (f.controlledBy ?? f.power) === myPower
  );

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
  const targets = (state.regions[regionId]?.placements ?? []).filter(
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

// ── Forced discard (Stolen Thoughts deferred) ─────────────────────────────────

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
        Stolen Thoughts — choose {count} card{count !== 1 ? 's' : ''} to discard ({selectedIndices.size}/{count} selected):
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

  const regionId = context['regionId'] as RegionId | undefined;
  const hitsRemaining = (context['hitsRemaining'] as number | undefined) ?? 0;
  if (!regionId) return null;
  const safeRegionId: RegionId = regionId;

  const region = state.regions[safeRegionId]!;
  const targets = region.placements.filter(f => {
    const ctrl = f.controlledBy ?? f.power;
    return ctrl !== myPower && !f.tipped && !f.protected;
  });

  function getDefense(fig: FollowerInstance): number {
    const owner = fig.power as Power;
    const def = FOLLOWERS[owner]?.[fig.class];
    if (!def) return 1;
    const isUpgraded = state.powers[owner]!.upgradesInPlay.some(u =>
      UPGRADES.find(up => up.id === u)?.upgradeType === fig.class
    );
    let d = isUpgraded ? def.upgraded.defense : def.base.defense;

    // Card modifiers in the region
    const regionCards = state.regions[safeRegionId]!.chaosCards;
    const rottingGrasp = regionCards.some(c => c?.cardId === 'gormen_rotting_grasp');
    const blightWard   = regionCards.some(c => c?.cardId === 'gormen_blight_ward');
    const nullWeave    = regionCards.some(c => c?.cardId === 'tenzen_null_weave');

    if (!nullWeave) {
      if (blightWard   && (fig.controlledBy ?? fig.power) === 'gormen') d += 1;
      if (rottingGrasp && (fig.controlledBy ?? fig.power) !== 'gormen') d = Math.max(1, d - 1);
    }

    return d;
  }

  function toggle(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const newTotal = Array.from(next).reduce((sum, fid) => {
          const f = targets.find(t => t.id === fid);
          return sum + (f ? getDefense(f) : 0);
        }, 0) + getDefense(targets.find(t => t.id === id)!);
        if (newTotal <= hitsRemaining) next.add(id);
      }
      return next;
    });
  }

  const selectedDefenseTotal = Array.from(selectedIds).reduce((sum, id) => {
    const f = targets.find(t => t.id === id);
    return sum + (f ? getDefense(f) : 0);
  }, 0);

  function handleConfirm() {
    onAction({
      kind: 'battle_hit_assignment',
      power: myPower,
      regionId: safeRegionId,
      followerIds: Array.from(selectedIds),
    });
    setSelectedIds(new Set());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#f87171' }}>
        Battle in {REGION_LABELS[safeRegionId]} — {hitsRemaining} hit(s) to assign
        ({selectedDefenseTotal}/{hitsRemaining} defense used):
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {targets.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No valid targets.</span>
        )}
        {targets.map(f => (
          <button
            key={f.id}
            className={selectedIds.has(f.id) ? 'danger' : 'secondary'}
            onClick={() => toggle(f.id)}
            style={{ fontSize: '0.8rem' }}
          >
            {POWER_LABELS_LOCAL[f.controlledBy ?? f.power] ?? f.power} {formatId(f.class)}
            <span style={{ color: '#94a3b8', marginLeft: 4 }}>def {getDefense(f)}</span>
          </button>
        ))}
      </div>
      <button className="danger" onClick={handleConfirm}>
        {selectedIds.size === 0 ? 'Apply hits (no kills)' : `Kill ${selectedIds.size} figure${selectedIds.size > 1 ? 's' : ''}`}
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
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const [selectedRegion, setSelectedRegion] = useState<RegionId | null>(null);
  const tokenType = (context['tokenType'] as string) ?? 'noble';
  const remaining = (context['remaining'] as number) ?? 1;

  const validRegions = ALL_REGIONS.filter(r => state.regions[r]!.ruinationCardIndex === null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — place a <strong style={{ color: '#facc15', textTransform: 'capitalize' }}>{tokenType}</strong> token
        on any region ({remaining} remaining):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {validRegions.map(r => (
          <button
            key={r}
            className={selectedRegion === r ? 'primary' : 'secondary'}
            onClick={() => setSelectedRegion(r)}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>
      {selectedRegion && (
        <button className="primary" onClick={() => {
          onAction({ kind: 'dial_place_token', power: myPower, regionId: selectedRegion });
          setSelectedRegion(null);
        }}>
          Place {tokenType} on {REGION_LABELS[selectedRegion]}
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
}: {
  state: GameState;
  myPower: Power;
  context: Record<string, unknown>;
  onAction: (action: Action) => void;
}) {
  const remaining = (context['remaining'] as number) ?? 1;
  const regionsWithOwn = ALL_REGIONS.filter(
    r => (state.regions[r]!.corruptionTokens[myPower] ?? 0) > 0,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — remove 1 of your corruption tokens ({remaining} remaining):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {regionsWithOwn.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No corruption to remove.</span>
        )}
        {regionsWithOwn.map(r => (
          <button
            key={r}
            className="danger"
            onClick={() => onAction({ kind: 'dial_remove_corruption', power: myPower, regionId: r })}
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
          >
            {REGION_LABELS[r]} ({state.regions[r]!.corruptionTokens[myPower]})
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Dial: remove world token ──────────────────────────────────────────────────

function DialRemoveWorldTokenPanel({
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
  const remaining = (context['remaining'] as number) ?? 1;
  type RemovableToken = 'event' | 'hero' | 'noble' | 'peasant' | 'ratmen';
  const TOKEN_NAMES: Record<RemovableToken, string> = {
    event: 'Event', hero: 'Hero', noble: 'Noble', peasant: 'Peasant', ratmen: 'Ratmen',
  };

  // Collect (region, tokenType) pairs
  const options: { regionId: RegionId; tokenType: RemovableToken }[] = [];
  for (const regionId of ALL_REGIONS) {
    const seen = new Set<string>();
    for (const t of state.regions[regionId]!.tokens) {
      if (t === 'chaos_stone') continue;
      if (seen.has(t)) continue;
      seen.add(t);
      options.push({ regionId, tokenType: t as RemovableToken });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
        Dial reward — remove a world token ({remaining} remaining):
      </div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {options.length === 0 && (
          <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>No tokens to remove.</span>
        )}
        {options.map(({ regionId, tokenType }) => (
          <button
            key={`${regionId}-${tokenType}`}
            className="danger"
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
