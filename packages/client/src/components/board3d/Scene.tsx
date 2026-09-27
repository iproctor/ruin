import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import type { Action, FollowerInstance, GameState, Power, RegionId, TokenType } from '@ruin/engine';
import { CARD_BY_ID, followersInRegion, REGION_ORDER } from '@ruin/engine';
import { POWER_COLORS } from '../../lib/display.js';
import type { TextureBank } from './textures.js';
import type { ProjectionRegistry } from './projection.js';
import {
  BOARD_D, BOARD_TOP, BOARD_W, CARD_D, CARD_W, STANDEE_ASPECT, STANDEE_H,
  cardSlotPos, corruptionPos, layoutStandees, regionFrame, tokenPos, type StandeeSlot,
} from './layout.js';

/** User-controlled view: zoom factor (1 = whole board) and pan offset. */
export interface ViewControl {
  zoom: number;
  panX: number;
  panZ: number;
  camera: THREE.PerspectiveCamera | null;
}

export interface SceneProps {
  view: ViewControl;
  state: GameState;
  bank: TextureBank;
  registry: ProjectionRegistry;
  highlight: Set<RegionId> | null;
  dimmed: Set<RegionId> | null;
  focusRegion: RegionId | null;
  hoverRegion?: RegionId | null;
  killedIds?: Set<string>;
  hideKilled?: boolean;
  appearingFigures?: Set<string>;
  appearingCards?: Set<string>;
  pendingAction?: Action | null;
  slotPlayable?: (regionId: RegionId, slot: 0 | 1) => boolean;
}

const ELEVATION = 1.1; // radians above horizontal (~63°)
const TARGET = new THREE.Vector3(0, 0, 0.2);

// ── Camera ──────────────────────────────────────────────────────────────────

function fitDistance(cam: THREE.PerspectiveCamera, dir: THREE.Vector3): number {
  // Board slab corners (top and bottom faces) plus headroom for the region
  // plaques along the back edge.
  const hw = BOARD_W / 2 + 0.24;
  const hd = BOARD_D / 2 + 0.24;
  const corners = [
    new THREE.Vector3(-hw, 0.35, -hd - 0.2), new THREE.Vector3(hw, 0.35, -hd - 0.2),
    new THREE.Vector3(-hw, -0.26, hd), new THREE.Vector3(hw, -0.26, hd),
    new THREE.Vector3(-hw, 0, hd), new THREE.Vector3(hw, 0, hd),
  ];
  const probe = cam.clone();
  let lo = 2;
  let hi = 60;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    probe.position.copy(TARGET).addScaledVector(dir, mid);
    probe.lookAt(TARGET);
    probe.updateMatrixWorld();
    probe.updateProjectionMatrix();
    const fits = corners.every((c) => {
      const p = c.clone().project(probe);
      return Math.abs(p.x) <= 0.97 && Math.abs(p.y) <= 0.96;
    });
    if (fits) hi = mid; else lo = mid;
  }
  return hi;
}

function CameraRig({ focusRegion, registry, view }: { focusRegion: RegionId | null; registry: ProjectionRegistry; view: ViewControl }) {
  const { camera, size } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  view.camera = cam;
  const dir = useMemo(() => new THREE.Vector3(0, Math.sin(ELEVATION), Math.cos(ELEVATION)).normalize(), []);
  const fit = useRef(20);
  const curTarget = useRef(TARGET.clone());
  const curDist = useRef(20);
  const initialized = useRef(false);

  useEffect(() => {
    cam.aspect = size.width / size.height;
    cam.updateProjectionMatrix();
    fit.current = fitDistance(cam, dir);
    if (!initialized.current) {
      curDist.current = fit.current * 1.25;
      initialized.current = true;
    }
  }, [cam, size.width, size.height, dir]);

  useFrame(({ clock }, dt) => {
    const t = clock.getElapsedTime();
    let goalTarget = new THREE.Vector3(TARGET.x + view.panX, 0, TARGET.z + view.panZ);
    let goalDist = fit.current * view.zoom;
    if (focusRegion) {
      const f = regionFrame(focusRegion);
      goalTarget = new THREE.Vector3(f.cx * 0.6, 0, f.cz * 0.6 + 0.2);
      goalDist = fit.current * 0.72;
    }
    const k = 1 - Math.pow(0.02, dt);
    curTarget.current.lerp(goalTarget, k);
    curDist.current += (goalDist - curDist.current) * k;
    // Slow "breathing" sway so the table never feels frozen.
    const sway = new THREE.Vector3(Math.sin(t * 0.13) * 0.05, 0, Math.cos(t * 0.11) * 0.04);
    cam.position.copy(curTarget.current).addScaledVector(dir, curDist.current).add(sway);
    cam.lookAt(curTarget.current);
    registry.project(cam, size.width, size.height);
  });
  return null;
}

// ── Lights & atmosphere ────────────────────────────────────────────────────

function Candle({ position, phase }: { position: [number, number, number]; phase: number }) {
  const light = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() + phase;
    if (light.current) light.current.intensity = 14 + Math.sin(t * 9.1) * 1.6 + Math.sin(t * 23.7) * 1.1 + Math.sin(t * 3.3) * 2;
  });
  return (
    <group position={position}>
      <pointLight ref={light} color="#ff9a4a" distance={16} decay={1.6} intensity={14} />
    </group>
  );
}

function Lights() {
  return (
    <>
      <ambientLight color="#7a6050" intensity={0.8} />
      <hemisphereLight color="#ffe2c0" groundColor="#1a0c06" intensity={0.7} />
      <directionalLight
        color="#ffe2b8"
        intensity={2.3}
        position={[-5, 11, 6]}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-bias={-0.0005}
      />
      <directionalLight color="#7a2a3a" intensity={0.5} position={[6, 3, -6]} />
      <Candle position={[-5.3, 1.5, 4.3]} phase={0} />
      <Candle position={[5.4, 1.5, -3.2]} phase={2.1} />
    </>
  );
}

// ── Table & board ──────────────────────────────────────────────────────────

function Table({ bank }: { bank: TextureBank }) {
  const tex = useMemo(() => bank.table(), [bank]);
  const mapTex = useMemo(() => {
    const t = new THREE.TextureLoader().load('/world_map.jpg');
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    // The board shows the top 730/800 of the square map image.
    t.repeat.set(1, 730 / 800);
    t.offset.set(0, 1 - 730 / 800);
    return t;
  }, []);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.26, 0]} receiveShadow>
        <planeGeometry args={[34, 23]} />
        <meshStandardMaterial map={tex} roughness={0.85} color="#8a7a6a" />
      </mesh>
      {/* Board slab */}
      <mesh position={[0, -0.13, 0]} castShadow receiveShadow>
        <boxGeometry args={[BOARD_W + 0.44, 0.26, BOARD_D + 0.44]} />
        <meshStandardMaterial color="#2a1a10" roughness={0.55} metalness={0.15} />
      </mesh>
      {/* Brass inlay rim */}
      <mesh position={[0, 0.001, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[BOARD_W + 0.14, BOARD_D + 0.14]} />
        <meshStandardMaterial color="#8a6034" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position={[0, BOARD_TOP - 0.01, 0]} rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[BOARD_W, BOARD_D]} />
        <meshStandardMaterial map={mapTex} roughness={0.9} bumpMap={mapTex} bumpScale={0.35} />
      </mesh>
    </group>
  );
}

// ── Region plates ──────────────────────────────────────────────────────────

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function RuinDecal({ regionId, bank, w, d }: { regionId: RegionId; bank: TextureBank; w: number; d: number }) {
  const tex = useMemo(() => bank.ruinDecal(regionId), [bank, regionId]);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (mat.current) mat.current.opacity = 0.82 + Math.sin(t * 2.3) * 0.08 + Math.sin(t * 7.1) * 0.05;
  });
  return (
    <mesh position={[0, 0, 0.003]} renderOrder={2}>
      <planeGeometry args={[w * 1.05, d * 1.05]} />
      <meshBasicMaterial ref={mat} map={tex} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function RegionPlate({ regionId, state, highlighted, dimmed, focused, hovered, bank }: {
  regionId: RegionId; state: GameState; highlighted: boolean; dimmed: boolean; focused: boolean; hovered: boolean; bank: TextureBank;
}) {
  const f = regionFrame(regionId);
  const region = state.regions[regionId]!;
  const ruined = region.ruinationCardIndex !== null;
  const shape = useMemo(() => roundedRect(f.w, f.d, 0.08), [f.w, f.d]);
  const edgePts = useMemo(() => shape.getPoints(8).map((p) => new THREE.Vector3(p.x, p.y, 0)), [shape]);
  const edgeGeom = useMemo(() => new THREE.BufferGeometry().setFromPoints(edgePts), [edgePts]);
  const fillMat = useRef<THREE.MeshBasicMaterial>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);

  // Persistent chaos cards tint the plate's edge in their owner's colour.
  const persistent = region.chaosCards
    .map((c) => (c ? CARD_BY_ID[c.cardId] : null))
    .find((d) => d?.timing === 'persistent');

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    if (fillMat.current) {
      if (highlighted) { fillMat.current.color.set('#facc15'); fillMat.current.opacity = 0.14 + pulse * 0.14; }
      else if (focused) { fillMat.current.color.set('#ff3b2f'); fillMat.current.opacity = 0.12 + pulse * 0.1; }
      else if (ruined) { fillMat.current.color.set('#2a0404'); fillMat.current.opacity = 0.72; }
      else if (hovered) { fillMat.current.color.set('#3a2410'); fillMat.current.opacity = 0.3; }
      else { fillMat.current.color.set('#0a0604'); fillMat.current.opacity = dimmed ? 0.62 : 0.34; }
    }
    if (edgeMat.current) {
      edgeMat.current.opacity = highlighted ? 0.6 + pulse * 0.4 : focused ? 0.9 : hovered ? 0.95 : persistent ? 0.55 + pulse * 0.25 : 0.4;
    }
  });

  const edgeColor = highlighted ? '#facc15' : focused ? '#ff3b2f' : ruined ? '#7f1d1d' : persistent ? POWER_COLORS[persistent.power] : hovered ? '#e8c070' : '#a97140';

  return (
    <group position={[f.cx, BOARD_TOP + 0.002, f.cz]} rotation-x={-Math.PI / 2}>
      <mesh renderOrder={1}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial ref={fillMat} transparent depthWrite={false} color="#0a0604" opacity={0.34} />
      </mesh>
      <lineLoop geometry={edgeGeom} renderOrder={2}>
        <lineBasicMaterial ref={edgeMat} color={edgeColor} transparent opacity={0.4} />
      </lineLoop>
      {ruined && <RuinDecal regionId={regionId} bank={bank} w={f.w} d={f.d} />}
      {ruined && (
        <Sparkles count={26} scale={[f.w, f.d, 0.6]} position={[0, 0, 0.3]} size={3} speed={0.6} color="#ff5a2a" opacity={0.9} />
      )}
    </group>
  );
}

// ── Standees ───────────────────────────────────────────────────────────────

function useBlobTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);
}

function Standee({ slot, bank, registry, blob, killed, appearing }: {
  slot: StandeeSlot;
  bank: TextureBank;
  registry: ProjectionRegistry;
  blob: THREE.Texture;
  killed: boolean;
  appearing: boolean;
}) {
  const f = slot.figure;
  const h = STANDEE_H[f.class];
  const w = h * STANDEE_ASPECT;
  const tex = useMemo(() => bank.standee(f.power, f.class), [bank, f.power, f.class]);
  const group = useRef<THREE.Group>(null);
  const card = useRef<THREE.Group>(null);
  const pos = useRef(new THREE.Vector3(slot.x, 0, slot.z));
  const from = useRef(new THREE.Vector3(slot.x, 0, slot.z));
  const hop = useRef(1);           // 0..1 progress of a move arc
  const spawn = useRef(appearing ? 0 : 0.999);
  const fall = useRef(0);
  const target = useMemo(() => new THREE.Vector3(slot.x, 0, slot.z), [slot.x, slot.z]);

  useEffect(() => {
    if (pos.current.distanceTo(target) > 0.4) {
      from.current.copy(pos.current);
      hop.current = 0;
    }
  }, [target]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    // Travel: long moves arc through the air, small ones slide.
    if (hop.current < 1) {
      hop.current = Math.min(1, hop.current + dt / 0.75);
      const e = 1 - Math.pow(1 - hop.current, 3);
      pos.current.lerpVectors(from.current, target, e);
      pos.current.y = Math.sin(Math.PI * hop.current) * 0.7;
    } else {
      pos.current.x += (target.x - pos.current.x) * Math.min(1, dt * 8);
      pos.current.z += (target.z - pos.current.z) * Math.min(1, dt * 8);
      pos.current.y = 0;
    }
    if (spawn.current < 1) spawn.current = Math.min(1, spawn.current + dt / 0.5);
    const s = spawn.current;
    const pop = s >= 1 ? 1 : 1 + Math.sin(s * Math.PI) * 0.35 - (1 - s) * 1;
    g.position.set(pos.current.x, BOARD_TOP + pos.current.y + (1 - s) * 0.6, pos.current.z);
    g.scale.setScalar(Math.max(0.001, pop));
    // Killed figures topple backwards.
    const fallGoal = killed || f.tipped ? 1 : 0;
    fall.current += (fallGoal - fall.current) * Math.min(1, dt * 6);
    if (card.current) {
      card.current.rotation.x = -0.72 - fall.current * 0.8;
      // Incarnations breathe: a slow menacing sway.
      if (f.class === 'incarnation' && fall.current < 0.05) card.current.rotation.z = Math.sin(performance.now() / 900 + slot.x * 3) * 0.04;
    }
    registry.move(`fig-${f.id}`, 0, g.position.x, g.position.y, g.position.z);
    registry.move(`fig-${f.id}`, 1, g.position.x, g.position.y + h * 0.75 * (1 - fall.current * 0.7), g.position.z - h * 0.66);
  });

  if (!slot.visible) return null;
  const ctrl = f.controlledBy;
  const baseR = w * 0.42;
  return (
    <group ref={group} position={[slot.x, BOARD_TOP, slot.z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0.03, 0.004, 0.05]} renderOrder={3}>
        <planeGeometry args={[baseR * 3, baseR * 2.4]} />
        <meshBasicMaterial map={blob} transparent depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.014, 0]} castShadow>
        <cylinderGeometry args={[baseR, baseR * 1.1, 0.028, 28]} />
        <meshStandardMaterial color={POWER_COLORS[f.power]} metalness={0.55} roughness={0.35} emissive={POWER_COLORS[f.power]} emissiveIntensity={0.18} />
      </mesh>
      {ctrl && (
        <mesh position={[0, 0.045, 0]} rotation-x={-Math.PI / 2}>
          <torusGeometry args={[baseR * 1.08, 0.014, 8, 32]} />
          <meshBasicMaterial color={POWER_COLORS[ctrl]} toneMapped={false} />
        </mesh>
      )}
      <group ref={card} position={[0, 0.026, 0]} rotation-x={-0.72}>
        <mesh position={[0, h / 2, 0]}>
          <planeGeometry args={[w, h]} />
          <meshStandardMaterial map={tex} alphaTest={0.5} side={THREE.DoubleSide} roughness={0.7} emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.18} />
        </mesh>
      </group>
      {f.protected && (
        <mesh position={[0, h * 0.55, 0]}>
          <sphereGeometry args={[h * 0.62, 24, 16]} />
          <meshBasicMaterial color="#7fd4ff" transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

// ── Cards on the table ─────────────────────────────────────────────────────

function TableCard({ cardId, x, z, bank, pending, appearing }: {
  cardId: string; x: number; z: number; bank: TextureBank; pending: boolean; appearing: boolean;
}) {
  const tex = useMemo(() => bank.card(cardId), [bank, cardId]);
  const ref = useRef<THREE.Group>(null);
  const t0 = useRef(appearing ? 0 : 1);
  const def = CARD_BY_ID[cardId];
  const glow = def ? POWER_COLORS[def.power] : '#8fa6c4';
  useFrame(({ clock }, dt) => {
    const g = ref.current;
    if (!g) return;
    if (t0.current < 1) t0.current = Math.min(1, t0.current + dt / 0.7);
    const s = t0.current;
    const drop = (1 - Math.pow(s, 2)) * 1.2;
    const lift = pending ? 0.14 + Math.sin(clock.getElapsedTime() * 3) * 0.03 : 0;
    g.position.set(x, BOARD_TOP + 0.012 + drop + lift, z);
    g.rotation.set(-Math.PI / 2, 0, (1 - s) * 1.6 + (cardId.length % 5 - 2) * 0.03);
  });
  return (
    <group ref={ref} position={[x, BOARD_TOP + 0.012, z]} rotation-x={-Math.PI / 2}>
      <mesh castShadow receiveShadow>
        <planeGeometry args={[CARD_W, CARD_D]} />
        <meshStandardMaterial map={tex} roughness={0.6} transparent />
      </mesh>
      <mesh position={[0, 0, -0.002]}>
        <planeGeometry args={[CARD_W + 0.05, CARD_D + 0.05]} />
        <meshBasicMaterial color={pending ? '#22c55e' : glow} transparent opacity={pending ? 0.8 : def?.timing === 'persistent' ? 0.45 : 0.15} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function EmptySlot({ x, z, playable }: { x: number; z: number; playable: boolean }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = playable ? 0.25 + 0.2 * Math.sin(clock.getElapsedTime() * 4) : 0.1;
  });
  return (
    <mesh position={[x, BOARD_TOP + 0.004, z]} rotation-x={-Math.PI / 2}>
      <planeGeometry args={[CARD_W, CARD_D]} />
      <meshBasicMaterial ref={mat} color={playable ? '#c68c5a' : '#000000'} transparent opacity={0.1} depthWrite={false} />
    </mesh>
  );
}

// ── Tokens & corruption ────────────────────────────────────────────────────

function TokenStack({ type, count, x, z, bank }: { type: TokenType; count: number; x: number; z: number; bank: TextureBank }) {
  const face = useMemo(() => bank.token(type), [bank, type]);
  const mats = useMemo(() => [
    new THREE.MeshStandardMaterial({ color: '#8a6a3a', metalness: 0.6, roughness: 0.4 }),
    new THREE.MeshStandardMaterial({ map: face, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: '#1a120b' }),
  ], [face]);
  const n = Math.min(count, 5);
  return (
    <group position={[x, BOARD_TOP, z]}>
      {Array.from({ length: n }).map((_, i) => (
        <mesh key={i} position={[i * 0.012, 0.016 + i * 0.03, -i * 0.01]} material={mats} castShadow>
          <cylinderGeometry args={[0.085, 0.085, 0.03, 32]} />
        </mesh>
      ))}
    </group>
  );
}

function CorruptionStack({ power, count, x, z, bank }: { power: Power; count: number; x: number; z: number; bank: TextureBank }) {
  const mats = useMemo(() => {
    const color = POWER_COLORS[power];
    return [
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, metalness: 0.3, roughness: 0.45 }),
      new THREE.MeshStandardMaterial({ map: bank.corruptionFace(power), emissive: color, emissiveIntensity: 0.15, roughness: 0.5 }),
      new THREE.MeshStandardMaterial({ color: '#0a0604' }),
    ];
  }, [power, bank]);
  const prev = useRef(count);
  const drops = useRef<number[]>([]);
  if (count > prev.current) {
    for (let i = prev.current; i < count; i++) drops.current[i] = 0;
  }
  prev.current = count;
  const group = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      const d = drops.current[i];
      if (d !== undefined && d < 1) {
        drops.current[i] = Math.min(1, d + dt / 0.45);
        const e = drops.current[i]!;
        child.position.y = 0.012 + i * 0.024 + (1 - e * e) * 0.9;
      } else {
        child.position.y = 0.012 + i * 0.024;
      }
    });
  });
  const n = Math.min(count, 12);
  return (
    <group ref={group} position={[x, BOARD_TOP, z]}>
      {Array.from({ length: n }).map((_, i) => (
        <mesh key={i} position={[((i * 7) % 3 - 1) * 0.004, 0.012 + i * 0.024, 0]} material={mats} castShadow>
          <cylinderGeometry args={[0.058, 0.06, 0.022, 24]} />
        </mesh>
      ))}
    </group>
  );
}

// ── Region contents ────────────────────────────────────────────────────────

function RegionPieces({ regionId, props }: { regionId: RegionId; props: SceneProps }) {
  const { state, bank, pendingAction, slotPlayable, appearingCards } = props;
  const f = regionFrame(regionId);
  const region = state.regions[regionId]!;
  const ruined = region.ruinationCardIndex !== null;
  const tokenCounts = new Map<TokenType, number>();
  for (const t of region.tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
  const corruption = (Object.entries(region.corruptionTokens) as [Power, number][]).filter(([, n]) => n > 0);
  const pending = pendingAction?.kind === 'summoning_play_card' && pendingAction.toRegion === regionId ? pendingAction : null;

  return (
    <group>
      {[...tokenCounts.entries()].map(([type, count], i) => {
        const [x, z] = tokenPos(f, i);
        return <TokenStack key={type} type={type} count={count} x={x} z={z} bank={bank} />;
      })}
      {corruption.map(([power, count], i) => {
        const [x, z] = corruptionPos(f, i);
        return <CorruptionStack key={power} power={power} count={count} x={x} z={z} bank={bank} />;
      })}
      {!ruined && ([0, 1] as const).map((si) => {
        const [x, z] = cardSlotPos(f, si);
        const card = region.chaosCards[si];
        const cardId = pending && pending.slotIndex === si ? pending.cardId : card?.cardId;
        if (cardId) {
          return (
            <TableCard
              key={`${si}-${cardId}`}
              cardId={cardId}
              x={x}
              z={z}
              bank={bank}
              pending={!!pending && pending.slotIndex === si}
              appearing={!!appearingCards?.has(`${regionId}-${si}`)}
            />
          );
        }
        return <EmptySlot key={si} x={x} z={z} playable={!!slotPlayable?.(regionId, si)} />;
      })}
    </group>
  );
}

// ── Scene ──────────────────────────────────────────────────────────────────

export function standeeLayout(state: GameState, killedIds: Set<string> | undefined, hideKilled: boolean | undefined) {
  const out: StandeeSlot[] = [];
  for (const regionId of REGION_ORDER) {
    let figs: FollowerInstance[] = followersInRegion(state, regionId);
    if (hideKilled && killedIds) figs = figs.filter((f) => !killedIds.has(f.id));
    out.push(...layoutStandees(figs, regionFrame(regionId)));
  }
  return out;
}

export default function Scene(props: SceneProps) {
  const { state, bank, registry, highlight, dimmed, focusRegion, killedIds, hideKilled, appearingFigures } = props;
  const blob = useBlobTexture();
  const standees = useMemo(() => standeeLayout(state, killedIds, hideKilled), [state, killedIds, hideKilled]);

  return (
    <>
      <color attach="background" args={['#070504']} />
      <fog attach="fog" args={['#070504', 14, 34]} />
      <CameraRig focusRegion={focusRegion} registry={registry} view={props.view} />
      <Lights />
      <Table bank={bank} />
      {REGION_ORDER.map((id) => (
        <RegionPlate
          key={id}
          regionId={id}
          state={state}
          highlighted={!!highlight?.has(id)}
          dimmed={!!dimmed?.has(id)}
          focused={focusRegion === id}
          hovered={props.hoverRegion === id}
          bank={bank}
        />
      ))}
      {REGION_ORDER.map((id) => <RegionPieces key={id} regionId={id} props={props} />)}
      {standees.map((s) => (
        <Standee
          key={s.figure.id}
          slot={s}
          bank={bank}
          registry={registry}
          blob={blob}
          killed={!!killedIds?.has(s.figure.id)}
          appearing={!!appearingFigures?.has(s.figure.id)}
        />
      ))}
      <Sparkles count={70} scale={[BOARD_W + 2, 2.4, BOARD_D + 2]} position={[0, 1.2, 0]} size={2.2} speed={0.25} color="#ffb070" opacity={0.45} />
    </>
  );
}
