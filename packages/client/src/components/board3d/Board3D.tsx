import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { RegionId } from '@ruin/engine';
import type { GameBoardProps } from '../GameBoard.js';
import { TextureBank } from './textures.js';
import { ProjectionRegistry } from './projection.js';
import Scene, { standeeLayout, type ViewControl } from './Scene.js';
import { BOARD_D, BOARD_W } from './layout.js';
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

  // ── View controls: wheel zoom toward the cursor, drag the table to pan ──
  const view = useMemo<ViewControl>(() => ({ zoom: 1, panX: 0, panZ: 0, camera: null }), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const clampPan = useCallback(() => {
    const room = (1 - view.zoom) * 0.9;
    view.panX = Math.max(-BOARD_W / 2 * room, Math.min(BOARD_W / 2 * room, view.panX));
    view.panZ = Math.max(-BOARD_D / 2 * room, Math.min(BOARD_D / 2 * room, view.panZ));
    setZoomed(view.zoom < 0.98);
  }, [view]);
  const groundPoint = useCallback((clientX: number, clientY: number) => {
    const cam = view.camera;
    const el = rootRef.current;
    if (!cam || !el) return null;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, cam);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? hit : null;
  }, [view]);
  const resetView = useCallback(() => {
    view.zoom = 1;
    view.panX = 0;
    view.panZ = 0;
    setZoomed(false);
  }, [view]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = view.zoom;
      view.zoom = Math.max(0.42, Math.min(1, view.zoom * Math.exp(e.deltaY * 0.0015)));
      // Zooming in drifts the view toward whatever is under the cursor.
      const p = groundPoint(e.clientX, e.clientY);
      if (p && view.zoom < before) {
        const k = (before - view.zoom) * 1.6;
        view.panX += (p.x - view.panX) * k;
        view.panZ += (p.z - view.panZ) * k;
      }
      clampPan();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view, groundPoint, clampPan]);

  const drag = useRef<{ x: number; y: number; px: number; pz: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    // Only empty table (the canvas itself) starts a pan; overlays keep their clicks and drags.
    if ((e.target as HTMLElement).tagName !== 'CANVAS' || view.zoom >= 0.98) return;
    drag.current = { x: e.clientX, y: e.clientY, px: view.panX, pz: view.panZ };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const el = rootRef.current;
    if (!d || !el) return;
    const scale = (BOARD_W * view.zoom * 1.3) / el.clientWidth;
    view.panX = d.px - (e.clientX - d.x) * scale;
    view.panZ = d.pz - (e.clientY - d.y) * scale * 1.1;
    clampPan();
  }
  function onPointerUp() { drag.current = null; }

  return (
    <div
      className={`b3 ${zoomed ? 'is-zoomed' : ''}`}
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).tagName === 'CANVAS') resetView(); }}
    >
      <Canvas
        shadows
        dpr={[1, 1.5]}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.3 }}
        camera={{ fov: 30, near: 0.1, far: 80, position: [0, 14, 10] }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Suspense fallback={null}>
          <Scene
            view={view}
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
      {zoomed && <button className="b3-reset" onClick={resetView} title="Show the whole board (double-click the table)">Reset view</button>}
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
