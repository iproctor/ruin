import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Power } from '@ruin/engine';
import { ParticleSystem, type BurstKind } from './particles.js';

/**
 * Screen-space anchors. Any element can mark itself with
 * `data-anchor="region-mittelreich"` (or slot-<region>-<i>, fig-<id>,
 * power-<power>, hand) and effects will find it by querying the DOM — this
 * works identically for the 2D SVG board and the 3D tabletop's HTML overlays.
 */
export function anchorRect(key: string): DOMRect | null {
  const el = document.querySelector(`[data-anchor="${CSS.escape(key)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  // Off-screen means "not placed yet" (3D overlays before their first projection).
  if (r.right < 0 || r.bottom < 0) return null;
  return r;
}

export function anchorCenter(key: string): { x: number; y: number } | null {
  const r = anchorRect(key);
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** An anchor key, a list of keys (first one found wins), or a screen point. */
export type FxTarget = string | string[] | { x: number; y: number };

export interface FxApi {
  burst: (at: FxTarget, kind: BurstKind, power?: Power | null, scale?: number) => void;
  trail: (from: FxTarget, to: FxTarget, color: string, count?: number, duration?: number) => void;
  shake: (strength?: number, ms?: number) => void;
}

const noop: FxApi = { burst: () => {}, trail: () => {}, shake: () => {} };
const FxContext = createContext<FxApi>(noop);

function resolve(at: FxTarget) {
  if (typeof at === 'string') return anchorCenter(at);
  if (Array.isArray(at)) {
    for (const k of at) {
      const c = anchorCenter(k);
      if (c) return c;
    }
    return null;
  }
  return at;
}

export function FxProvider({ children, shakeRoot }: { children: ReactNode; shakeRoot?: React.RefObject<HTMLElement> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sysRef = useRef<ParticleSystem | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const sys = new ParticleSystem(canvasRef.current);
    sysRef.current = sys;
    const onResize = () => sys.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      sys.dispose();
      sysRef.current = null;
    };
  }, []);

  const api = useMemo<FxApi>(() => ({
    burst(at, kind, power = null, scale = 1) {
      const p = resolve(at);
      // Anchored bursts keep tracking their element (e.g. a region while the camera dollies).
      const locate = typeof at === 'object' && !Array.isArray(at) ? undefined : () => resolve(at);
      if (p && sysRef.current) sysRef.current.burst(p.x, p.y, kind, power, scale, locate);
    },
    trail(from, to, color, count, duration) {
      const a = resolve(from);
      const b = resolve(to);
      if (a && b && sysRef.current) sysRef.current.trail(a.x, a.y, b.x, b.y, color, count, duration);
    },
    shake(strength = 8, ms = 500) {
      const el = shakeRoot?.current;
      if (!el || typeof el.animate !== 'function') return;
      const frames: Keyframe[] = [];
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const k = (1 - i / n) * strength;
        frames.push({ transform: i === n ? 'translate(0,0)' : `translate(${(Math.random() - 0.5) * 2 * k}px, ${(Math.random() - 0.5) * 2 * k}px) rotate(${(Math.random() - 0.5) * k * 0.08}deg)` });
      }
      el.animate(frames, { duration: ms, easing: 'ease-out' });
    },
  }), [shakeRoot]);

  return (
    <FxContext.Provider value={api}>
      {children}
      <canvas
        ref={canvasRef}
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 400 }}
      />
    </FxContext.Provider>
  );
}

export function useFx(): FxApi {
  return useContext(FxContext);
}
