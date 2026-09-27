import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type AnimSpeed = 'slow' | 'normal' | 'fast';
export type BoardView = '3d' | '2d';
export type Graphics = 'high' | 'low';

export interface Settings {
  sound: boolean;
  music: boolean;
  volume: number;          // 0..1
  animSpeed: AnimSpeed;
  cinematics: boolean;     // full-screen battle / spell / ruination scenes
  boardView: BoardView;
  graphics: Graphics;      // tabletop quality (low: no shadows / mist / embers)
}

/** Multiplier applied to every animation and event-queue delay. */
export const SPEED_FACTOR: Record<AnimSpeed, number> = { slow: 1.5, normal: 1, fast: 0.5 };

const DEFAULTS: Settings = {
  sound: true,
  music: true,
  volume: 0.7,
  animSpeed: 'normal',
  cinematics: true,
  boardView: '3d',
  graphics: 'high',
};

const STORAGE_KEY = 'ruin_settings_v1';

function defaults(): Settings {
  // Respect an OS-level request for less motion.
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return { ...DEFAULTS, cinematics: false, animSpeed: 'fast' };
    }
  } catch { /* matchMedia unavailable */ }
  return DEFAULTS;
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return defaults();
  }
}

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue>({ settings: DEFAULTS, update: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
