/**
 * Single source of truth for the in-game grimdark palette. Use these constants
 * in TS/JSX (SVG `fill=`/`stroke=`, inline `style={{ ... }}`). The matching
 * CSS variables live in `src/pages/GamePage.css` — keep them in sync with
 * this file.
 */

/* ── Ground / surface ──────────────────────────────────────────────────── */
export const INK         = '#0a0806'; // page background, SVG bg
export const INK_DEEP    = '#050302';
export const SOOT        = '#140e0a'; // panel body, region fill, separators
export const PARCHMENT   = '#1c1510'; // card surface, hover
export const PARCHMENT_HI = '#241b14';

/* ── Lines ─────────────────────────────────────────────────────────────── */
export const BORDER      = '#3a2a1e';
export const BORDER_HI   = '#5a4028';

/* ── Text ──────────────────────────────────────────────────────────────── */
export const PAPER       = '#d9c7a7'; // body
export const PAPER_DIM   = '#9a8a74';
export const PAPER_FADE  = '#6b5c4c';

/* ── Card face — cool slate to break the brown-on-brown chrome ────────── */
export const CARD_FACE     = '#222830';
export const CARD_FACE_HI  = '#262d35'; // selected / highlighted
export const CARD_EDGE     = '#121518'; // same hue as face, darker — for borders
export const CARD_INK      = '#e8dcc8'; // bright paper for text on slate

/* ── Accents ───────────────────────────────────────────────────────────── */
export const BRASS       = '#a97140';
export const BRASS_HOT   = '#c68c5a';
export const BRASS_DIM   = '#3c2814'; // dark brass, used for active tab/button bg
export const BLOOD       = '#c21818';

/* ── Semantic (highlight / danger / okay) ──────────────────────────────── */
export const HIGHLIGHT   = '#facc15'; // hover / selection ring / POP label
export const RUINED      = '#7f1d1d';
export const RUINED_TEXT = '#ff7a7a';
export const PENDING     = '#22c55e'; // staged card green (keep semantic)
export const ERROR       = '#f87171';
export const MAGIC       = '#3d8ec8'; // ✦ magic symbol (on cards + tooltips)

/* ── Darker / less neon power tints ────────────────────────────────────── */
/* Use these for large UI surfaces (tableau borders, confirm buttons) where
 * the canonical POWER_COLORS read as too saturated. */
import type { Power } from '@ruin/engine';
export const POWER_DIM: Record<Power, string> = {
  xarm:   '#a11414', // muted blood
  gormen: '#5e7a28', // darker slime
  tenzen: '#2f6e9a', // deeper arcane
  lasha:  '#7a2f98', // darker obscene
};
