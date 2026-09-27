import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings, type AnimSpeed, type BoardView, type Graphics } from '../contexts/SettingsContext.js';

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="gset-row">
      <span>{label}</span>
      <button className={`gset-toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on}>
        <i />
      </button>
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void;
}) {
  return (
    <div className="gset-row">
      <span>{label}</span>
      <div className="gset-choice">
        {options.map(([v, l]) => (
          <button key={v} className={v === value ? 'is-on' : ''} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/** Gear button + popover for presentation settings (sound, pacing, view). */
export default function SettingsMenu() {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle() {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.max(8, r.right - 280) });
    }
    setOpen((o) => !o);
  }

  const muted = !settings.sound;
  return (
    <>
      <button
        className="gsb-menu-btn gsb-gear"
        onClick={() => update({ sound: muted })}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute (sound is off)' : 'Mute all sound'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 9h4l5-4v14l-5-4H4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          {muted
            ? <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            : <path d="M16.5 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
        </svg>
      </button>
      <button ref={btn} className="gsb-menu-btn gsb-gear" onClick={toggle} aria-label="Settings" title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.6" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={panel} className="gset" style={{ top: pos.top, left: pos.left }}>
          <div className="gset-title">Presentation</div>
          <Choice<BoardView> label="Board" value={settings.boardView} options={[['3d', 'Tabletop'], ['2d', 'Map']]} onChange={(v) => update({ boardView: v })} />
          {settings.boardView === '3d' && (
            <Choice<Graphics> label="Detail" value={settings.graphics} options={[['high', 'High'], ['low', 'Low']]} onChange={(v) => update({ graphics: v })} />
          )}
          <Toggle label="Cinematics" on={settings.cinematics} onChange={(v) => update({ cinematics: v })} />
          <Choice<AnimSpeed> label="Pace" value={settings.animSpeed} options={[['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]} onChange={(v) => update({ animSpeed: v })} />
          <div className="gset-title" style={{ marginTop: 10 }}>Sound</div>
          <Toggle label="Effects" on={settings.sound} onChange={(v) => update({ sound: v })} />
          <Toggle label="Ambience" on={settings.music} onChange={(v) => update({ music: v })} />
          <label className="gset-row">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => update({ volume: Number(e.target.value) })}
            />
          </label>
        </div>,
        document.body,
      )}
    </>
  );
}
