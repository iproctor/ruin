import { useState } from 'react';
import type {
  GameState,
  Power,
  Action,
  RegionId,
  FollowerInstance,
} from '@ruin/engine';

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
