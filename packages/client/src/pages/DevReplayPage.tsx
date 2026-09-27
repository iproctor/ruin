import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GameEvent, Power, RegionId } from '@ruin/engine';
import { generateDemoGame } from '../lib/demoGame.js';
import { useLocalReplay } from '../hooks/useLocalReplay.js';
import { eventDuration } from '../lib/timing.js';
import { SPEED_FACTOR, useSettings } from '../contexts/SettingsContext.js';
import { SoundProvider } from '../contexts/SoundContext.js';
import { FxProvider } from '../components/fx/FxProvider.js';
import CinematicLayer from '../components/cinematics/CinematicLayer.js';
import GameBoard from '../components/GameBoard.js';
import StatusBar from '../components/StatusBar.js';
import './GamePage.css';

function Inner({ seed, viewer }: { seed: number; viewer: Power[] }) {
  const { settings } = useSettings();
  const demo = useMemo(() => generateDemoGame(seed), [seed]);
  const timing = useRef({ myPowers: viewer, cinematics: settings.cinematics, speed: SPEED_FACTOR[settings.animSpeed] });
  timing.current = { myPowers: viewer, cinematics: settings.cinematics, speed: SPEED_FACTOR[settings.animSpeed] };
  const dur = useCallback((e: GameEvent) => eventDuration(e, timing.current), []);
  const r = useLocalReplay(demo.initial, demo.events, dur);
  const state = r.state;
  // Mirror GamePage: dominations and the focused region during corruption.
  const [doms, setDoms] = useState<Map<RegionId, { power: Power; vp: number }>>(new Map());
  const [focus, setFocus] = useState<RegionId | null>(null);
  useEffect(() => r.subscribe((ev) => {
    if (ev.type === 'phase_start') { setDoms(new Map()); setFocus(null); }
    if (ev.type === 'domination_result' && ev.power && ev.conquered) {
      const p = ev.power;
      setDoms((m) => new Map(m).set(ev.regionId, { power: p, vp: ev.vp }));
      setFocus(ev.regionId);
    }
    if (ev.type === 'corruption_placement' || ev.type === 'ruination') setFocus(ev.regionId);
  }), [r.subscribe]);
  if (!state) return null;

  const btn: React.CSSProperties = { fontFamily: 'Cinzel', fontSize: 12, padding: '4px 10px', background: '#2a1a0c', color: '#f4e6cc', border: '1px solid #5a4028' };
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0806' }}>
      <StatusBar state={state} myPower={null} players={[]} events={r.log} />
      <div style={{ display: 'flex', gap: 8, padding: 6, alignItems: 'center', color: '#9a8a74', fontSize: 12 }}>
        <button style={btn} onClick={r.running ? r.stop : r.play}>{r.running ? 'Stop' : 'Play'}</button>
        <button style={btn} onClick={() => r.skipUntil((e) => e.type === 'phase_start' && e.phase === 'battle')}>→ battle</button>
        <button style={btn} onClick={() => r.skipUntil((e) => e.type === 'battle_region_start')}>→ next fight</button>
        <button style={btn} onClick={() => r.skipUntil((e) => e.type === 'play_card')}>→ card</button>
        <button style={btn} onClick={() => r.skipUntil((e) => e.type === 'ruination')}>→ ruin</button>
        <button style={btn} onClick={() => r.skipUntil((e) => e.type === 'game_over')}>→ end</button>
        <span>seed {seed} · {demo.events.length} events · final round {demo.final.round} · winner {demo.final.winners?.join(',') ?? '—'}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', padding: 8 }}>
        <GameBoard state={state} dominationLabels={doms} animationRegion={focus} />
        <CinematicLayer subscribe={r.subscribe} state={state} myPowers={viewer} paused={r.paused} onResume={r.resume} />
      </div>
    </div>
  );
}

/** Dev-only: replay a locally generated AI game through the full cinematic pipeline. */
export default function DevReplayPage() {
  const [params] = useSearchParams();
  const seed = Number(params.get('seed') ?? 11);
  const viewer = (params.get('as')?.split(',').filter(Boolean) ?? []) as Power[];
  const shakeRef = useRef<HTMLDivElement>(null);
  return (
    <SoundProvider>
      <FxProvider shakeRoot={shakeRef}>
        <div ref={shakeRef}>
          <Inner seed={seed} viewer={viewer} />
        </div>
      </FxProvider>
    </SoundProvider>
  );
}
