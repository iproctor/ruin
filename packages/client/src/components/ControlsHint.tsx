import { useState } from 'react';

const KEY = 'ruin_controls_hint_v1';

function seen(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; }
}

/** One-time primer on the tabletop's controls (the rules themselves are assumed). */
export default function ControlsHint() {
  const [open, setOpen] = useState(() => !seen());
  if (!open) return null;
  const dismiss = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* storage unavailable */ }
    setOpen(false);
  };
  return (
    <div className="ctl-hint" role="note">
      <div className="ctl-hint-title">At the table</div>
      <ul>
        <li><b>Drag</b> cards and followers from your tableau onto a region, or click a region's <b>+</b>.</li>
        <li><b>Scroll</b> to lean in, <b>drag</b> the table to look around, <b>double-click</b> to sit back.</li>
        <li><b>Hover</b> anything for details. Pace, sound and the flat map live under the gear.</li>
      </ul>
      <button className="primary" onClick={dismiss}>Understood</button>
    </div>
  );
}
