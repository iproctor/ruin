import type { Power } from '@ruin/engine';

/** Power accent colors — single source of truth for the client. */
export const POWER_COLORS: Record<Power, string> = {
  xarm:   '#ef4444',
  gormen: '#22c55e',
  tenzen: '#38bdf8',
  lasha:  '#a855f7',
};

export const POWER_BG: Record<Power, string> = {
  xarm:   '#7f1d1d',
  gormen: '#14532d',
  tenzen: '#0c4a6e',
  lasha:  '#581c87',
};

export const POWER_LABELS: Record<Power, string> = {
  xarm:   'Xarm',
  gormen: 'Gormen',
  tenzen: 'Tenzen',
  lasha:  'Lasha',
};

export const PHASE_LABELS: Record<string, string> = {
  lobby:      'Lobby',
  world:      'World',
  draw:       'Draw',
  summoning:  'Summoning',
  battle:     'Battle',
  corruption: 'Corruption',
  end:        'End of Round',
  completed:  'Game Over',
};

/** Pick the most memorable single word from a card name. */
const SKIP_WORDS = new Set(['the', 'of', 'a', 'an', 'in', 'for', 'and', 'or', 'to']);
export function shortCardName(name: string): string {
  const words = name.split(' ');
  for (let i = words.length - 1; i >= 0; i--) {
    if (!SKIP_WORDS.has(words[i]!.toLowerCase())) return words[i]!;
  }
  return words[words.length - 1] ?? name;
}
