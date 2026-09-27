import type { FollowerClass, Power, RegionId, TokenType } from '@ruin/engine';

// Generated paintings live in src/assets/art/<kind>/<id>.webp (see
// scripts/art/). Missing art is fine: every lookup returns undefined and the
// renderer falls back to a procedural gradient.
const files = import.meta.glob('../assets/art/*/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const BY_KEY = new Map<string, string>();
for (const [p, url] of Object.entries(files)) {
  const m = /art\/([^/]+)\/([^/]+)\.webp$/.exec(p);
  if (m) BY_KEY.set(`${m[1]}/${m[2]}`, url);
}

const get = (kind: string, id: string) => BY_KEY.get(`${kind}/${id}`);

export const chaosCardArt = (cardId: string) => get('cards', cardId);
export const upgradeArt = (upgradeId: string) => get('upgrades', upgradeId);
export const worldCardArt = (cardId: string) => get('world', cardId);
export const followerArt = (power: Power, cls: FollowerClass) => get('followers', `${power}_${cls}`);
export const godArt = (power: Power) => get('gods', power);
export const regionArt = (regionId: RegionId) => get('regions', regionId);
export const tokenArt = (token: TokenType) => get('tokens', token);
export const miscArt = (id: 'table' | 'card_back') => get('misc', id);

/** Any card id (chaos, world or upgrade) → its painting. */
export function anyCardArt(id: string): string | undefined {
  return chaosCardArt(id) ?? worldCardArt(id) ?? upgradeArt(id);
}

/** Every art URL, for warming the browser cache at game load. */
export function allArtUrls(): string[] {
  return [...BY_KEY.values()];
}
