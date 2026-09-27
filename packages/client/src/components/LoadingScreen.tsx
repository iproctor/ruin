import type { Power } from '@ruin/engine';
import { POWER_COLORS } from '../lib/display.js';
import { godArt } from '../lib/art.js';
import { PowerSigil } from './PowerSigil.js';

const ORDER: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

/** Shown while the game connects: the four gods waking one after another. */
export default function LoadingScreen({ label = 'Setting the table' }: { label?: string }) {
  return (
    <div className="loading-screen">
      <div className="loading-gods">
        {ORDER.map((p, i) => (
          <div
            key={p}
            className="loading-god"
            style={{ ['--accent' as string]: POWER_COLORS[p], animationDelay: `${i * 0.35}s` }}
          >
            <div className="loading-god-art" style={godArt(p) ? { backgroundImage: `url(${godArt(p)})` } : undefined} />
            <span className="loading-god-sigil"><PowerSigil power={p} size={26} /></span>
          </div>
        ))}
      </div>
      <div className="loading-label">{label}</div>
    </div>
  );
}
