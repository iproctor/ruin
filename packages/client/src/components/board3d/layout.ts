import type { FollowerClass, FollowerInstance, Power, RegionId } from '@ruin/engine';
import { REGION_POSITIONS, BOARD_VIEWBOX_W, BOARD_VIEWBOX_H } from '../Board.js';

/** World units per board pixel (board viewBox is 800×730 px). */
export const PX = 1 / 100;
export const BOARD_W = BOARD_VIEWBOX_W * PX;   // 8
export const BOARD_D = BOARD_VIEWBOX_H * PX;   // 7.3
export const BOARD_TOP = 0.02;                 // y of the map surface

export function toWorld(px: number, py: number): [number, number] {
  return [px * PX - BOARD_W / 2, py * PX - BOARD_D / 2];
}

export interface RegionFrame {
  x0: number; z0: number; w: number; d: number;
  cx: number; cz: number;
}

export function regionFrame(id: RegionId): RegionFrame {
  const p = REGION_POSITIONS[id];
  const [x0, z0] = toWorld(p.x, p.y);
  const w = p.w * PX;
  const d = p.h * PX;
  return { x0, z0, w, d, cx: x0 + w / 2, cz: z0 + d / 2 };
}

export const STANDEE_H: Record<FollowerClass, number> = { cultist: 0.36, warrior: 0.44, incarnation: 0.62 };
export const STANDEE_ASPECT = 0.74; // width / height

const POWER_ORDER: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const CLASS_ORDER: FollowerClass[] = ['incarnation', 'warrior', 'cultist'];

/** Max standees drawn per identical group; the rest show as a ×N badge. */
export const GROUP_VISIBLE = 3;

export interface StandeeSlot {
  figure: FollowerInstance;
  x: number; z: number;
  /** Position within its group (0 = front). */
  depth: number;
  /** Total members in the group (for the ×N badge on the front standee). */
  groupSize: number;
  visible: boolean;
}

function groupKey(f: FollowerInstance) {
  return `${f.power}|${f.class}|${f.controlledBy ?? ''}|${f.protected ? 1 : 0}`;
}

/**
 * Arrange a region's figures as small formations: one column per
 * (power, class) group, laid out left→right in power order across the
 * left two-thirds of the region. Groups larger than GROUP_VISIBLE stack.
 */
export function layoutStandees(figures: FollowerInstance[], frame: RegionFrame): StandeeSlot[] {
  const groups = new Map<string, FollowerInstance[]>();
  const sorted = [...figures].sort((a, b) => {
    const pa = POWER_ORDER.indexOf(a.controlledBy ?? a.power);
    const pb = POWER_ORDER.indexOf(b.controlledBy ?? b.power);
    if (pa !== pb) return pa - pb;
    return CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class);
  });
  for (const f of sorted) {
    const k = groupKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const cols = [...groups.values()];
  const areaX0 = frame.x0 + 0.14;
  const areaX1 = frame.x0 + frame.w - 0.66;
  const areaW = areaX1 - areaX0;
  const n = cols.length;
  // Two rows when crowded.
  const rows = n > 6 ? 2 : 1;
  const perRow = Math.ceil(n / rows);
  const step = perRow > 1 ? Math.min(0.26, areaW / (perRow - 1)) : 0;
  const rowZ = rows === 1 ? [frame.z0 + 0.78] : [frame.z0 + 0.62, frame.z0 + 0.95];
  const out: StandeeSlot[] = [];
  cols.forEach((members, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = areaX0 + col * step + (rows === 2 && row === 1 ? step / 2 : 0);
    // Neighbouring portraits overlap when a region is crowded; at the same depth
    // they're coplanar and z-fight. Stagger alternate columns back into a loose
    // formation, plus a small per-column step so no two columns ever share a plane.
    const z = rowZ[row]! - (col % 2) * 0.09 - col * 0.006;
    members.forEach((f, j) => {
      out.push({
        figure: f,
        x: x + j * 0.035,
        z: z - j * 0.07,
        depth: j,
        groupSize: members.length,
        visible: j < GROUP_VISIBLE,
      });
    });
  });
  return out;
}

/** Centres of the two chaos-card slots, lying flat at the region's right. */
export const CARD_W = 0.27;
export const CARD_D = CARD_W * 1.4;
export function cardSlotPos(frame: RegionFrame, slot: 0 | 1): [number, number] {
  const x = frame.x0 + frame.w - 0.36 + (slot === 0 ? -0.14 : 0.16);
  const z = frame.z0 + 0.8 + (slot === 0 ? 0 : 0.02);
  return [x, z];
}

/** World-token discs along the top-left of the region. */
export function tokenPos(frame: RegionFrame, index: number): [number, number] {
  return [frame.x0 + 0.16 + index * 0.21, frame.z0 + 0.3];
}

/** Corruption stacks along the top-right. */
export function corruptionPos(frame: RegionFrame, index: number): [number, number] {
  return [frame.x0 + frame.w - 0.16 - index * 0.16, frame.z0 + 0.3];
}

/** Positions of the world-track cards and the World deck, off the board's west edge. */
export const WORLD_CARD_W = 0.6;
export const WORLD_TRACK_X = -BOARD_W / 2 - 0.22 - 0.12 - WORLD_CARD_W / 2;
export const WORLD_TRACK_Z = [-2.05, -1.05, 0.05] as const; // deck, slot 1, slot 2

/** Threat dials and the ruination pile, off the board's east edge. */
export const DIAL_X = BOARD_W / 2 + 0.22 + 0.12 + 0.34;
export const DIAL_R = 0.3;
export const DIAL_Z = [-2.3, -1.55, -0.8, -0.05] as const;
export const RUIN_PILE_Z = 0.95;
