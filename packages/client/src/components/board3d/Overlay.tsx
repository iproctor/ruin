import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { FollowerInstance, GameState, Power, RegionId, TokenType } from '@ruin/engine';
import { REGION_ORDER, REGIONS } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../../lib/display.js';
import { regionStats } from '../../lib/regionStats.js';
import { tokenArt } from '../../lib/art.js';
import type { DragItem } from '../../types/drag.js';
import CardTooltip from '../CardTooltip.js';
import FollowerTooltip from '../FollowerTooltip.js';
import { RegionInfoTooltip, TokenTooltip, TOKEN_COLORS, TOKEN_NAMES } from '../Board.js';
import type { ProjectionMode, ProjectionRegistry } from './projection.js';
import { BOARD_TOP, CARD_D, CARD_W, GROUP_VISIBLE, STANDEE_ASPECT, STANDEE_H, cardSlotPos, regionFrame, type StandeeSlot, WORLD_CARD_W, WORLD_TRACK_X, WORLD_TRACK_Z, DIAL_X, DIAL_R, DIAL_Z, RUIN_PILE_Z } from './layout.js';

function useProjected(registry: ProjectionRegistry, key: string, points: THREE.Vector3[], mode: ProjectionMode, aspect = 1) {
  const elRef = useRef<HTMLElement | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    if (elRef.current) registry.set(key, elRef.current, pointsRef.current, mode, aspect);
  });
  useEffect(() => () => { registry.delete(key, elRef.current ?? undefined); }, [registry, key]);
  return useCallback((el: HTMLElement | null) => {
    if (el) {
      elRef.current = el;
      registry.set(key, el, pointsRef.current, mode, aspect);
    }
  }, [registry, key, mode, aspect]);
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ── Region banner ──────────────────────────────────────────────────────────

function RegionBanner({ regionId, state, registry, domination }: {
  regionId: RegionId; state: GameState; registry: ProjectionRegistry; domination?: { power: Power; vp: number };
}) {
  const f = regionFrame(regionId);
  const pts = useMemo(() => [v(f.cx, BOARD_TOP, f.z0 + 0.04)], [f.cx, f.z0]);
  const ref = useProjected(registry, `banner-${regionId}`, pts, 'point');
  const st = regionStats(state, regionId);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [tokTip, setTokTip] = useState<{ token: TokenType; x: number; y: number } | null>(null);
  const ruinColor = st.topRuiner ? POWER_COLORS[st.topRuiner] : '#9a8a74';

  return (
    <div ref={ref} className={`b3-banner ${st.ruined ? 'is-ruined' : ''}`}>
      <div
        className="b3-banner-name"
        onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTip(null)}
      >
        {REGIONS[regionId].name}
        {st.populous && <span className="b3-pop" title="Populous">◆</span>}
      </div>
      <div className="b3-banner-stats">
        <span title="Resistance">R{st.resistance}</span>
        <span title="Conquest value">V{st.value}</span>
        {st.ruined ? (
          <span className="b3-ruined">Ruined</span>
        ) : (
          <>
            {st.leader && <span style={{ color: POWER_COLORS[st.leader.power], fontWeight: 800 }} title="Dominating">D{st.leader.value}</span>}
            {!st.leader && st.contender && <span style={{ color: POWER_COLORS[st.contender.power] }} title="Short of domination">D{st.contender.short}</span>}
            <span
              style={{ color: ruinColor, fontWeight: st.danger ? 900 : 600 }}
              className={st.danger ? 'b3-danger' : ''}
              title="Corruption (+ incoming)"
            >
              C{st.corruption}{st.incoming > 0 ? `+${st.incoming}` : ''}{st.danger ? '!' : ''}
            </span>
            {st.dacEarners.length > 0 && (
              <span className="b3-dac" title="Dial advancement this round">
                {st.dacEarners.map((p) => <i key={p} style={{ background: POWER_COLORS[p] }} />)}
              </span>
            )}
          </>
        )}
      </div>
      {st.tokenCounts.size > 0 && (
        <div className="b3-banner-tokens">
          {[...st.tokenCounts.entries()].map(([t, n]) => (
            <span
              key={t}
              className="b3-tok"
              style={{ ['--tok' as string]: TOKEN_COLORS[t] }}
              onMouseEnter={(e) => setTokTip({ token: t, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setTokTip({ token: t, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTokTip(null)}
              title={TOKEN_NAMES[t]}
            >
              {tokenArt(t) ? <img src={tokenArt(t)} alt="" /> : null}
              {n > 1 && <b>{n}</b>}
            </span>
          ))}
        </div>
      )}
      {domination && (
        <div className="b3-dom" style={{ ['--accent' as string]: POWER_COLORS[domination.power] }}>
          {POWER_LABELS[domination.power]} dominates <b>+{domination.vp} VP</b>
        </div>
      )}
      {tip && <RegionInfoTooltip state={state} regionId={regionId} x={tip.x} y={tip.y} />}
      {tokTip && <TokenTooltip token={tokTip.token} x={tokTip.x} y={tokTip.y} />}
    </div>
  );
}

// ── Region drop zone (also the FX anchor for the region) ────────────────────

function RegionZone({ regionId, registry, active, onClick }: {
  regionId: RegionId; registry: ProjectionRegistry; active: boolean; onClick?: () => void;
}) {
  const f = regionFrame(regionId);
  const pts = useMemo(() => [
    v(f.x0, BOARD_TOP, f.z0), v(f.x0 + f.w, BOARD_TOP, f.z0),
    v(f.x0, BOARD_TOP, f.z0 + f.d), v(f.x0 + f.w, BOARD_TOP, f.z0 + f.d),
  ], [f.x0, f.z0, f.w, f.d]);
  const projRef = useProjected(registry, `zone-${regionId}`, pts, 'rect');
  const { setNodeRef, isOver } = useDroppable({ id: regionId, data: { kind: 'region', regionId } });
  const ref = useCallback((el: HTMLDivElement | null) => { setNodeRef(el); projRef(el); }, [setNodeRef, projRef]);
  return (
    <div
      ref={ref}
      data-anchor={`region-${regionId}`}
      className={`b3-zone ${isOver ? 'is-over' : ''}`}
      style={{ pointerEvents: active ? 'auto' : 'none', cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
    />
  );
}

// ── Card slot hotspot ──────────────────────────────────────────────────────

function SlotZone({ regionId, slot, registry, cardId, clickable, onClick, onHover }: {
  regionId: RegionId; slot: 0 | 1; registry: ProjectionRegistry; cardId: string | null;
  clickable: boolean; onClick?: (x: number, y: number) => void;
  onHover?: (key: string | null) => void;
}) {
  const f = regionFrame(regionId);
  const [x, z] = cardSlotPos(f, slot);
  const pts = useMemo(() => [
    v(x - CARD_W / 2, BOARD_TOP, z - CARD_D / 2), v(x + CARD_W / 2, BOARD_TOP, z - CARD_D / 2),
    v(x - CARD_W / 2, BOARD_TOP, z + CARD_D / 2), v(x + CARD_W / 2, BOARD_TOP, z + CARD_D / 2),
  ], [x, z]);
  const ref = useProjected(registry, `slot-${regionId}-${slot}`, pts, 'rect');
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      ref={ref}
      data-anchor={`slot-${regionId}-${slot}`}
      className={`b3-slot ${clickable ? 'is-clickable' : ''}`}
      style={{ pointerEvents: cardId || clickable ? 'auto' : 'none' }}
      onClick={clickable && onClick ? (e) => { e.stopPropagation(); onClick(e.clientX, e.clientY); } : undefined}
      onMouseEnter={cardId ? (e) => { setTip({ x: e.clientX, y: e.clientY }); onHover?.(`${regionId}-${slot}`); } : undefined}
      onMouseMove={cardId ? (e) => setTip({ x: e.clientX, y: e.clientY }) : undefined}
      onMouseLeave={() => { setTip(null); onHover?.(null); }}
    >
      {clickable && <span className="b3-slot-plus">+</span>}
      {tip && cardId && <CardTooltip cardId={cardId} x={tip.x} y={tip.y} />}
    </div>
  );
}

// ── Summon button ──────────────────────────────────────────────────────────

function SummonButton({ regionId, registry, onClick }: { regionId: RegionId; registry: ProjectionRegistry; onClick: (x: number, y: number) => void }) {
  const f = regionFrame(regionId);
  const pts = useMemo(() => [v(f.x0 + f.w - 0.72, BOARD_TOP, f.z0 + 0.62)], [f.x0, f.w, f.z0]);
  const ref = useProjected(registry, `summon-${regionId}`, pts, 'point');
  return (
    <button
      ref={ref}
      className="b3-summon"
      title="Summon a follower"
      onClick={(e) => { e.stopPropagation(); onClick(e.clientX, e.clientY); }}
    >
      +
    </button>
  );
}

// ── Figure handle (hover tooltip, drag, FX anchor) ─────────────────────────

function FigureHandle({ slot, registry, state, draggable, regionId, passThrough }: {
  slot: StandeeSlot; registry: ProjectionRegistry; state: GameState; draggable: boolean; regionId: RegionId;
  /** While the player is picking a region, clicks must reach the region zone underneath. */
  passThrough: boolean;
}) {
  const f = slot.figure;
  const h = STANDEE_H[f.class];
  const pts = useMemo(() => [v(slot.x, BOARD_TOP, slot.z), v(slot.x, BOARD_TOP + h * 0.75, slot.z - h * 0.66)], [slot.x, slot.z, h]);
  const projRef = useProjected(registry, `fig-${f.id}`, pts, 'span', STANDEE_ASPECT);
  const dragData: DragItem = { kind: 'board_follower', followerId: f.id, followerClass: f.class, power: (f.controlledBy ?? f.power), fromRegion: regionId };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `board_fig_${f.id}`, data: dragData, disabled: !draggable });
  const ref = useCallback((el: HTMLDivElement | null) => { setNodeRef(el); projRef(el); }, [setNodeRef, projRef]);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const extra = slot.depth === 0 && slot.groupSize > GROUP_VISIBLE ? slot.groupSize : 0;
  return (
    <div
      ref={ref}
      data-anchor={`fig-${f.id}`}
      className={`b3-fig ${draggable ? 'is-draggable' : ''}`}
      style={{ opacity: isDragging ? 0.2 : 1, pointerEvents: slot.visible && !passThrough ? 'auto' : 'none' }}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTip(null)}
    >
      {extra > 0 && <span className="b3-fig-count" style={{ ['--ring' as string]: POWER_COLORS[f.power] }}>×{extra}</span>}
      {tip && !isDragging && (
        <FollowerTooltip
          power={f.power}
          followerClass={f.class}
          upgradesInPlay={state.powers[f.power]?.upgradesInPlay ?? []}
          x={tip.x}
          y={tip.y}
        />
      )}
    </div>
  );
}

// ── World track hover zones ───────────────────────────────────────────────

function WorldZone({ registry, cardId, index, label }: { registry: ProjectionRegistry; cardId: string | null; index: number; label: string }) {
  const w = WORLD_CARD_W;
  const d = w * 1.4;
  const z = WORLD_TRACK_Z[index]!;
  const pts = useMemo(() => [
    v(WORLD_TRACK_X - w / 2, -0.25, z - d / 2), v(WORLD_TRACK_X + w / 2, -0.25, z - d / 2),
    v(WORLD_TRACK_X - w / 2, -0.25, z + d / 2), v(WORLD_TRACK_X + w / 2, -0.25, z + d / 2),
  ], [w, d, z]);
  const ref = useProjected(registry, `worldzone-${index}`, pts, 'rect');
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      ref={ref}
      className="b3-world"
      style={{ pointerEvents: cardId ? 'auto' : 'none' }}
      onMouseEnter={cardId ? (e) => setTip({ x: e.clientX, y: e.clientY }) : undefined}
      onMouseMove={cardId ? (e) => setTip({ x: e.clientX, y: e.clientY }) : undefined}
      onMouseLeave={() => setTip(null)}
    >
      <span className="b3-world-label">{label}</span>
      {tip && cardId && <CardTooltip cardId={cardId} x={tip.x} y={tip.y} />}
    </div>
  );
}

// ── Threat dial / ruin pile labels ─────────────────────────────────────────

function SideLabel({ registry, id, x, z, children }: { registry: ProjectionRegistry; id: string; x: number; z: number; children: React.ReactNode }) {
  const pts = useMemo(() => [v(x, -0.2, z)], [x, z]);
  const ref = useProjected(registry, id, pts, 'point');
  return <div ref={ref} className="b3-side-label">{children}</div>;
}

// ── Overlay root ───────────────────────────────────────────────────────────

export interface OverlayProps {
  state: GameState;
  registry: ProjectionRegistry;
  standees: StandeeSlot[];
  dragActive: boolean;
  myPower?: Power | null;
  onRegionClick?: (regionId: RegionId) => void;
  onSlotClick?: (regionId: RegionId, slotIndex: 0 | 1, x: number, y: number) => void;
  slotPlayable?: (regionId: RegionId, slotIndex: 0 | 1) => boolean;
  onSummonClick?: (regionId: RegionId, x: number, y: number) => void;
  canSummon?: (regionId: RegionId) => boolean;
  dominationLabels?: Map<RegionId, { power: Power; vp: number }>;
  onSlotHover?: (key: string | null) => void;
}

export default function Overlay(props: OverlayProps) {
  const { state, registry, standees, dragActive, myPower, onRegionClick, onSlotClick, slotPlayable, onSummonClick, canSummon, dominationLabels, onSlotHover } = props;
  const regionOf = useMemo(() => {
    const m = new Map<string, RegionId>();
    for (const r of REGION_ORDER) for (const s of standees) if (s.figure.regionId === r) m.set(s.figure.id, r);
    return m;
  }, [standees]);
  return (
    <div className="b3-overlay">
      {REGION_ORDER.map((id) => (
        <RegionZone key={`z-${id}`} regionId={id} registry={registry} active={dragActive || !!onRegionClick} onClick={onRegionClick ? () => onRegionClick(id) : undefined} />
      ))}
      {REGION_ORDER.map((id) => {
        const region = state.regions[id]!;
        if (region.ruinationCardIndex !== null) return null;
        return ([0, 1] as const).map((si) => (
          <SlotZone
            key={`s-${id}-${si}`}
            regionId={id}
            slot={si}
            registry={registry}
            cardId={region.chaosCards[si]?.cardId ?? null}
            clickable={!region.chaosCards[si] && !!onSlotClick && !!slotPlayable?.(id, si)}
            onClick={onSlotClick ? (x, y) => onSlotClick(id, si, x, y) : undefined}
            onHover={onSlotHover}
          />
        ));
      })}
      {standees.map((s) => (
        <FigureHandle
          key={s.figure.id}
          slot={s}
          registry={registry}
          state={state}
          regionId={regionOf.get(s.figure.id) ?? (s.figure.regionId as RegionId)}
          draggable={!!myPower && (s.figure.controlledBy ?? s.figure.power) === myPower && s.visible}
          passThrough={!!onRegionClick}
        />
      ))}
      {REGION_ORDER.map((id) => (
        <RegionBanner key={`b-${id}`} regionId={id} state={state} registry={registry} domination={dominationLabels?.get(id)} />
      ))}
      {state.activePowers.map((p, i) => {
        const ps = state.powers[p]!;
        return (
          <SideLabel key={`dial-${p}`} registry={registry} id={`dial-${p}`} x={DIAL_X + DIAL_R + 0.08} z={DIAL_Z[i] ?? 0}>
            <span style={{ color: POWER_COLORS[p] }}>{POWER_LABELS[p]}</span>
            <b>{ps.threatValue}</b>
          </SideLabel>
        );
      })}
      <SideLabel registry={registry} id="ruin-pile" x={DIAL_X} z={RUIN_PILE_Z + 0.5}>
        <span>Ruination</span><b>{Math.max(0, 5 - state.ruinationCardsUsed)}</b>
      </SideLabel>
      <WorldZone registry={registry} cardId={null} index={0} label={`World deck · ${state.worldDeck.length}`} />
      <WorldZone registry={registry} cardId={state.worldTrack.slot1} index={1} label={state.worldTrack.slot1 ? '' : ''} />
      <WorldZone registry={registry} cardId={state.worldTrack.slot2} index={2} label="" />
      {onSummonClick && REGION_ORDER.filter((id) => canSummon?.(id) && state.regions[id]!.ruinationCardIndex === null).map((id) => (
        <SummonButton key={`p-${id}`} regionId={id} registry={registry} onClick={(x, y) => onSummonClick(id, x, y)} />
      ))}
    </div>
  );
}

export type { FollowerInstance };
