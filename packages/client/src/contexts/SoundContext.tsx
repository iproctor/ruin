import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { SoundEngine } from '../lib/sfx.js';
import { MUSIC_TRACK } from '../lib/music.js';
import { useSettings } from './SettingsContext.js';

const SoundContext = createContext<SoundEngine | null>(null);

export function SoundProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<SoundEngine | null>(null);
  if (!engineRef.current) engineRef.current = new SoundEngine(MUSIC_TRACK);
  const engine = engineRef.current;
  const { settings } = useSettings();

  useEffect(() => {
    engine.setVolume(settings.volume);
    engine.setEnabled(settings.sound);
    engine.setMusic(settings.music);
  }, [engine, settings.volume, settings.sound, settings.music]);

  // Audio can only start after a user gesture.
  useEffect(() => {
    const unlock = () => engine.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  return <SoundContext.Provider value={engine}>{children}</SoundContext.Provider>;
}

/** The page's sound engine. Outside a provider, returns a silent stand-in. */
export function useSound(): SoundEngine {
  const engine = useContext(SoundContext);
  const fallback = useRef<SoundEngine | null>(null);
  if (engine) return engine;
  if (!fallback.current) {
    fallback.current = new SoundEngine();
    fallback.current.enabled = false;
  }
  return fallback.current;
}
