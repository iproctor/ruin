import { useMemo, useState } from 'react';
import { CHAOS_CARDS, UPGRADES, WORLD_CARDS, createInitialState } from '@ruin/engine';
import type { GameState } from '@ruin/engine';
import GameCard from '../components/cards/GameCard.js';
import ActionPanel from '../components/ActionPanel.js';

/** Dev-only visual harness (route /dev). Renders every card and lets the
 *  cinematic layer be triggered without playing a game. */
function BoonPreview() {
  const state = useMemo<GameState>(() => {
    const s = createInitialState({ gameId: 'dev', activePowers: ['xarm', 'gormen', 'tenzen', 'lasha'], playerTypes: { xarm: 'human', gormen: 'ai', tenzen: 'ai', lasha: 'ai' }, seed: 3 });
    return { ...s, pendingAction: { waitingFor: 'lasha', actionKind: 'upgrade_choice', context: {} } };
  }, []);
  return <ActionPanel state={state} myPower="lasha" selectedCardId={null} onAction={() => {}} onClearCard={() => {}} />;
}

export default function DevGalleryPage() {
  const [boon, setBoon] = useState(false);
  return (
    <div className="game-ui" style={{ minHeight: '100vh', background: '#0a0806', padding: 24, overflow: 'auto', height: '100vh' }}>
      <button className="primary" onClick={() => setBoon((b) => !b)} style={{ position: 'fixed', right: 20, top: 20, zIndex: 900 }}>Toggle boon modal</button>
      {boon && <BoonPreview />}
      <h2 style={{ fontFamily: 'Cinzel', color: '#d9c7a7', marginBottom: 12 }}>Chaos cards</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {CHAOS_CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="md" interactive />)}
      </div>
      <h2 style={{ fontFamily: 'Cinzel', color: '#d9c7a7', margin: '24px 0 12px' }}>Hand size</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {CHAOS_CARDS.slice(0, 12).map((c) => <GameCard key={c.id} cardId={c.id} size="sm" interactive />)}
        {CHAOS_CARDS.slice(0, 12).map((c) => <GameCard key={c.id + 'x'} cardId={c.id} size="xs" />)}
        <GameCard cardId="back" size="sm" faceDown />
      </div>
      <h2 style={{ fontFamily: 'Cinzel', color: '#d9c7a7', margin: '24px 0 12px' }}>Upgrades</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {UPGRADES.map((c) => <GameCard key={c.id} cardId={c.id} size="md" interactive />)}
      </div>
      <h2 style={{ fontFamily: 'Cinzel', color: '#d9c7a7', margin: '24px 0 12px' }}>World</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {WORLD_CARDS.map((c) => <GameCard key={c.id} cardId={c.id} size="md" interactive />)}
      </div>
    </div>
  );
}
