import { BOARD_D, BOARD_TOP, BOARD_W, PX } from './layout.js';

/**
 * Light relief for the tabletop map. Heights come from hand-placed mountain
 * ridges that follow the painted map (board pixel coords, 800×730), with
 * noise so peaks vary along each range. The field is computed once into a
 * constant grid; `groundY` samples it so every piece on the board sits on the
 * same surface the map mesh is displaced to.
 */

interface Ridge {
  /** Spine as board-pixel points. */
  path: Array<[number, number]>;
  /** Peak height in world units. */
  height: number;
  /** Half-width of the range in board pixels. */
  width: number;
}

const RIDGES: Ridge[] = [
  // Scandinavia: the long spine of the northern landmass.
  { path: [[140, 160], [200, 132], [270, 104], [350, 72], [420, 44], [480, 18]], height: 0.17, width: 26 },
  // The northern wastes along the top-right snowfields.
  { path: [[530, 28], [600, 18], [680, 26], [760, 44], [800, 60]], height: 0.12, width: 24 },
  // Grey Mountains between Normagne and Mittelreich.
  { path: [[405, 330], [430, 400], [462, 470], [500, 535]], height: 0.14, width: 18 },
  // The southern chain (Apuccini / Black Mountains) above Toscavar and Pelascos.
  { path: [[285, 578], [360, 574], [440, 566], [520, 520], [610, 458], [700, 430], [790, 420]], height: 0.16, width: 20 },
  // Irrana ridge between Almerida and Toscavar.
  { path: [[286, 575], [280, 640], [272, 725]], height: 0.1, width: 14 },
  // Ridge east of Toscavar.
  { path: [[456, 580], [446, 645], [436, 725]], height: 0.09, width: 14 },
  // World's Edge range along the eastern rim.
  { path: [[792, 290], [772, 360], [782, 440], [790, 540]], height: 0.15, width: 20 },
];

/** Broad rolling hills (centre, radius, height) — badlands and border princes. */
/** Global relief multiplier: how pronounced the terrain is. */
const RELIEF = 1.9;

const HILLS: Array<[number, number, number, number]> = [
  [700, 660, 70, 0.05],
  [650, 520, 55, 0.035],
  [560, 610, 45, 0.03],
];

// ── Deterministic value noise ────────────────────────────────────────────────

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(x * freq, y * freq);
    freq *= 2.1;
    amp *= 0.5;
  }
  return sum; // ~0..1
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Height (world units) at a board-pixel position, before sampling into the grid. */
function heightAtPx(px: number, py: number): number {
  let h = 0;
  for (const r of RIDGES) {
    let d = Infinity;
    for (let i = 0; i < r.path.length - 1; i++) {
      const [ax, ay] = r.path[i]!;
      const [bx, by] = r.path[i + 1]!;
      d = Math.min(d, segDist(px, py, ax, ay, bx, by));
    }
    if (d > r.width * 3) continue;
    // Peaks rise and fall along the range; craggy detail near the spine.
    const peaks = 0.45 + 0.9 * fbm(px / 38, py / 38);
    const crag = 0.75 + 0.5 * fbm(px / 9 + 17, py / 9 + 3);
    const fall = Math.exp(-((d / r.width) ** 2));
    h = Math.max(h, r.height * fall * peaks * crag);
  }
  for (const [cx, cy, rad, amp] of HILLS) {
    const d = Math.hypot(px - cx, py - cy);
    if (d < rad * 2) h += amp * Math.exp(-((d / rad) ** 2)) * (0.6 + 0.8 * fbm(px / 25 + 5, py / 25 + 9));
  }
  // Fade to flat at the board's edges so the map meets the frame cleanly.
  const edge = Math.min(px, py, 800 - px, 730 - py);
  const edgeK = Math.max(0, Math.min(1, (edge - 4) / 26));
  return RELIEF * h * edgeK * edgeK * (3 - 2 * edgeK);
}

// ── Precomputed grid ─────────────────────────────────────────────────────────

const STEP = 2.5; // board px per grid cell
const GW = Math.round(800 / STEP) + 1;
const GH = Math.round(730 / STEP) + 1;

const GRID: Float32Array = (() => {
  const g = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) g[j * GW + i] = heightAtPx(i * STEP, j * STEP);
  }
  return g;
})();

/** Terrain height (world units above the flat map) at a world x/z. */
export function terrainHeight(x: number, z: number): number {
  const gx = Math.max(0, Math.min(GW - 1.001, (x + BOARD_W / 2) / PX / STEP));
  const gy = Math.max(0, Math.min(GH - 1.001, (z + BOARD_D / 2) / PX / STEP));
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const fx = gx - i;
  const fy = gy - j;
  const a = GRID[j * GW + i]!;
  const b = GRID[j * GW + i + 1]!;
  const c = GRID[(j + 1) * GW + i]!;
  const d = GRID[(j + 1) * GW + i + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** World y of the map surface at x/z (what pieces should stand on). */
export function groundY(x: number, z: number): number {
  return BOARD_TOP + terrainHeight(x, z);
}

/** Highest ground under a flat rectangle (so cards and coins never sink into a slope). */
export function groundYUnder(x: number, z: number, halfW: number, halfD: number): number {
  let y = -Infinity;
  for (const dx of [-halfW, 0, halfW]) {
    for (const dz of [-halfD, 0, halfD]) y = Math.max(y, groundY(x + dx, z + dz));
  }
  return y;
}
