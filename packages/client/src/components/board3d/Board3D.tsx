import { Suspense, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { RegionId } from '@ruin/engine';
import type { GameBoardProps } from '../GameBoard.js';
import { TextureBank } from './textures.js';
import { ProjectionRegistry } from './projection.js';
import Scene, { standeeLayout } from './Scene.js';
import Overlay from './Overlay.js';
import './board3d.css';

/** The tabletop: a WebGL diorama with HTML overlays for every interaction. */
export default function Board3D(props: GameBoardProps) {
  const {
    state, highlightRegions, dimmedRegions, pendingAction, onRegionClick, myPower, animationRegion,
    animationKilledIds, hideKilled, summoningAnim, onSlotClick, slotPlayable, onSummonClick, canSummon, dominationLabels,
  } = props;
  const bank = useMemo(() => new TextureBank(8), []);
  const registry = useMemo(() => new ProjectionRegistry(), []);
  useEffect(() => () => bank.dispose(), [bank]);

  const highlight = useMemo(() => (highlightRegions ? new Set<RegionId>(highlightRegions) : null), [highlightRegions]);
  const dimmed = useMemo(() => (dimmedRegions ? new Set<RegionId>(dimmedRegions) : null), [dimmedRegions]);
  const dragActive = highlightRegions !== undefined || dimmedRegions !== undefined;
  const standees = useMemo(() => standeeLayout(state, animationKilledIds, hideKilled), [state, animationKilledIds, hideKilled]);

  return (
    <div className="b3">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.3 }}
        camera={{ fov: 30, near: 0.1, far: 80, position: [0, 14, 10] }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Suspense fallback={null}>
          <Scene
            state={state}
            bank={bank}
            registry={registry}
            highlight={highlight}
            dimmed={dimmed}
            focusRegion={animationRegion ?? null}
            killedIds={animationKilledIds}
            hideKilled={hideKilled}
            appearingFigures={summoningAnim?.appearingFigures}
            appearingCards={summoningAnim?.appearingCards}
            pendingAction={pendingAction}
            slotPlayable={slotPlayable}
          />
        </Suspense>
      </Canvas>
      <div className="b3-vignette" />
      <Overlay
        state={state}
        registry={registry}
        standees={standees}
        dragActive={dragActive}
        myPower={myPower}
        onRegionClick={onRegionClick}
        onSlotClick={onSlotClick}
        slotPlayable={slotPlayable}
        onSummonClick={onSummonClick}
        canSummon={canSummon}
        dominationLabels={dominationLabels}
      />
    </div>
  );
}
