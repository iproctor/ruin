import * as THREE from 'three';
import type { FollowerClass, Power, TokenType } from '@ruin/engine';
import { CARD_BY_ID } from '@ruin/engine';
import { POWER_COLORS } from '../../lib/display.js';
import { chaosCardArt, followerArt, miscArt, tokenArt } from '../../lib/art.js';

/**
 * Canvas-composited textures for the 3D board. Each texture is drawn at
 * once with a placeholder and repainted when its art finishes loading.
 * One bank per board instance (owned by Board3D), disposed on unmount.
 */
export class TextureBank {
  private cache = new Map<string, THREE.Texture>();
  private images = new Map<string, Promise<HTMLImageElement>>();
  private maxAniso: number;

  constructor(maxAnisotropy = 4) {
    this.maxAniso = maxAnisotropy;
  }

  dispose() {
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
  }

  private load(url: string): Promise<HTMLImageElement> {
    let p = this.images.get(url);
    if (!p) {
      p = new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
      this.images.set(url, p);
    }
    return p;
  }

  private make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, img: HTMLImageElement | null) => void, url?: string): THREE.Texture {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    draw(g, null);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    this.cache.set(key, tex);
    if (url) {
      this.load(url).then((img) => {
        g.clearRect(0, 0, w, h);
        draw(g, img);
        tex.needsUpdate = true;
      }).catch(() => { /* keep placeholder */ });
    }
    return tex;
  }

  /** Arch-topped standee portrait with a frame in the owner's colour. */
  standee(power: Power, cls: FollowerClass): THREE.Texture {
    const W = 192;
    const H = Math.round(W / 0.74);
    const color = POWER_COLORS[power];
    return this.make(`standee:${power}:${cls}`, W, H, (g, img) => {
      const border = cls === 'incarnation' ? 12 : 9;
      const arch = (inset: number) => {
        const r = (W - inset * 2) / 2;
        g.beginPath();
        g.moveTo(inset, H - inset);
        g.lineTo(inset, r + inset);
        g.arc(W / 2, r + inset, r, Math.PI, 0);
        g.lineTo(W - inset, H - inset);
        g.closePath();
      };
      // Outer frame
      arch(0);
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#2a1d12');
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, '#1a120b');
      g.fillStyle = grad;
      g.fill();
      if (cls === 'incarnation') {
        arch(3);
        g.strokeStyle = '#e8c070';
        g.lineWidth = 3;
        g.stroke();
      }
      // Art window
      g.save();
      arch(border);
      g.clip();
      g.fillStyle = '#120d0a';
      g.fillRect(0, 0, W, H);
      if (img) {
        const s = Math.max((W - border * 2) / img.width, (H - border * 2) / img.height);
        const iw = img.width * s;
        const ih = img.height * s;
        g.drawImage(img, (W - iw) / 2, border, iw, ih);
      } else {
        g.fillStyle = color;
        g.globalAlpha = 0.35;
        g.beginPath();
        g.arc(W / 2, H * 0.45, W * 0.25, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
      // Bottom shade
      const shade = g.createLinearGradient(0, H * 0.6, 0, H);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,0,0.65)');
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
      g.restore();
      // Inner bevel line
      arch(border - 2);
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 2;
      g.stroke();
    }, followerArt(power, cls));
  }

  /** Face of a chaos card lying on the table. */
  card(cardId: string): THREE.Texture {
    const W = 180;
    const H = 252;
    const def = CARD_BY_ID[cardId];
    const color = def ? POWER_COLORS[def.power] : '#8fa6c4';
    return this.make(`card:${cardId}`, W, H, (g, img) => {
      const r = 14;
      const rr = (x: number, y: number, w: number, h: number, rad: number) => {
        g.beginPath();
        g.roundRect(x, y, w, h, rad);
      };
      rr(0, 0, W, H, r);
      g.fillStyle = '#1a120b';
      g.fill();
      rr(4, 4, W - 8, H - 8, r - 3);
      g.fillStyle = color;
      g.fill();
      g.save();
      rr(10, 10, W - 20, H - 20, r - 6);
      g.clip();
      g.fillStyle = '#120d0a';
      g.fillRect(0, 0, W, H);
      if (img) {
        const s = Math.max((W - 20) / img.width, (H - 20) / img.height);
        g.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      }
      const shade = g.createLinearGradient(0, H * 0.55, 0, H);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,0,0.85)');
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
      g.restore();
      if (def) {
        // Cost gem
        g.beginPath();
        g.arc(30, 30, 20, 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = '#1a120b';
        g.stroke();
        g.fillStyle = '#fff8ec';
        g.font = '900 26px Cinzel, serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(def.cost), 30, 32);
        // Name
        g.font = '700 21px Cinzel, serif';
        g.fillStyle = '#f4e6cc';
        g.shadowColor = '#000';
        g.shadowBlur = 6;
        const name = def.shortName ?? def.name;
        g.fillText(name.length > 12 ? name.slice(0, 11) + '…' : name, W / 2, H - 28);
        g.shadowBlur = 0;
        if (def.hasMagicSymbol) {
          g.beginPath();
          g.arc(W - 28, 28, 14, 0, Math.PI * 2);
          g.fillStyle = '#1a3a60';
          g.fill();
          g.fillStyle = '#bfe6ff';
          g.font = '20px serif';
          g.fillText('✦', W - 28, 30);
        }
      }
    }, chaosCardArt(cardId));
  }

  /** Circular coin face for a world token. */
  token(type: TokenType): THREE.Texture {
    const S = 128;
    const RIM: Record<TokenType, string> = {
      event: '#6366f1', hero: '#f59e0b', noble: '#eab308', peasant: '#a8a29e', ratmen: '#10b981', chaos_stone: '#14b8a6',
    };
    return this.make(`token:${type}`, S, S, (g, img) => {
      g.fillStyle = RIM[type];
      g.fillRect(0, 0, S, S);
      g.save();
      g.beginPath();
      g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = '#120d0a';
      g.fillRect(0, 0, S, S);
      if (img) g.drawImage(img, 0, 0, S, S);
      g.restore();
      g.beginPath();
      g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.stroke();
    }, tokenArt(type));
  }

  /** Dark leather/wood table surface; painted art when available. */
  table(): THREE.Texture {
    const W = 1024;
    const H = 683;
    const tex = this.make('table', W, H, (g, img) => {
      if (img) {
        g.drawImage(img, 0, 0, W, H);
        return;
      }
      const grad = g.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, W * 0.7);
      grad.addColorStop(0, '#2a1d14');
      grad.addColorStop(1, '#080504');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `rgba(${60 + Math.random() * 40},${40 + Math.random() * 20},${20},${Math.random() * 0.08})`;
        g.fillRect(0, Math.random() * H, W, 1 + Math.random() * 2);
      }
    }, miscArt('table'));
    return tex;
  }
}
