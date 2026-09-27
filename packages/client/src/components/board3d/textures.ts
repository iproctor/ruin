import * as THREE from 'three';
import type { FollowerClass, Power, TokenType } from '@ruin/engine';
import { CARD_BY_ID, WORLD_CARD_BY_ID } from '@ruin/engine';
import { POWER_COLORS } from '../../lib/display.js';
import { chaosCardArt, followerArt, godArt, miscArt, tokenArt, worldCardArt } from '../../lib/art.js';

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
      const world = WORLD_CARD_BY_ID[cardId];
      if (world) {
        g.font = '700 19px Cinzel, serif';
        g.fillStyle = '#f4e6cc';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.shadowColor = '#000';
        g.shadowBlur = 6;
        const nm = world.name;
        g.fillText(nm.length > 15 ? nm.slice(0, 14) + '…' : nm, W / 2, H - 28);
        g.shadowBlur = 0;
      }
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
    }, chaosCardArt(cardId) ?? worldCardArt(cardId));
  }

  /** Face of a threat dial: god portrait inside a ringed band of ticks. */
  dialFace(power: Power, ticks: number): THREE.Texture {
    const S = 256;
    const color = POWER_COLORS[power];
    return this.make(`dial:${power}:${ticks}`, S, S, (g, img) => {
      const c = S / 2;
      g.fillStyle = '#1a120b';
      g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
      // Band
      g.beginPath(); g.arc(c, c, c - 6, 0, Math.PI * 2);
      g.fillStyle = color; g.globalAlpha = 0.35; g.fill(); g.globalAlpha = 1;
      g.lineWidth = 4; g.strokeStyle = '#c68c5a'; g.stroke();
      // Ticks from -150° to +150° (0 = up)
      for (let i = 0; i < ticks; i++) {
        const a = (-150 + (300 * i) / Math.max(1, ticks - 1)) * (Math.PI / 180) - Math.PI / 2;
        const last = i === ticks - 1;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * (c - 10), c + Math.sin(a) * (c - 10));
        g.lineTo(c + Math.cos(a) * (c - (last ? 34 : 26)), c + Math.sin(a) * (c - (last ? 34 : 26)));
        g.lineWidth = last ? 7 : 4;
        g.strokeStyle = last ? '#ff5a4a' : '#f4e6cc';
        g.stroke();
      }
      // Portrait
      g.save();
      g.beginPath(); g.arc(c, c, c * 0.62, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#120d0a'; g.fillRect(0, 0, S, S);
      if (img) {
        const s2 = (c * 1.24) / Math.min(img.width, img.height * 0.66);
        g.drawImage(img, c - (img.width * s2) / 2, c - c * 0.62 - img.height * s2 * 0.05, img.width * s2, img.height * s2);
      }
      g.restore();
      g.beginPath(); g.arc(c, c, c * 0.62, 0, Math.PI * 2);
      g.lineWidth = 5; g.strokeStyle = color; g.stroke();
    }, godArt(power));
  }

  /** A war banner in the god's colour bearing its portrait. */
  banner(power: Power): THREE.Texture {
    const W = 128;
    const H = 192;
    const color = POWER_COLORS[power];
    return this.make(`banner:${power}`, W, H, (g, img) => {
      // Swallow-tailed cloth
      g.beginPath();
      g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H); g.lineTo(W / 2, H - 34); g.lineTo(0, H); g.closePath();
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, color);
      grad.addColorStop(1, '#140806');
      g.fillStyle = grad;
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = '#c68c5a';
      g.stroke();
      if (img) {
        g.save();
        g.beginPath(); g.arc(W / 2, 70, 40, 0, Math.PI * 2); g.clip();
        const sc = 80 / Math.min(img.width, img.height * 0.66);
        g.drawImage(img, W / 2 - (img.width * sc) / 2, 30 - img.height * sc * 0.04, img.width * sc, img.height * sc);
        g.restore();
        g.beginPath(); g.arc(W / 2, 70, 40, 0, Math.PI * 2);
        g.lineWidth = 4; g.strokeStyle = '#e8c070'; g.stroke();
      }
    }, godArt(power));
  }

  /** Back of a card (painted card back). */
  cardBack(): THREE.Texture {
    const W = 180;
    const H = 252;
    return this.make('card-back', W, H, (g, img) => {
      g.fillStyle = '#1a120b';
      g.beginPath();
      g.roundRect(0, 0, W, H, 14);
      g.fill();
      if (img) {
        g.save();
        g.beginPath();
        g.roundRect(6, 6, W - 12, H - 12, 10);
        g.clip();
        g.drawImage(img, 0, 0, W, H);
        g.restore();
      }
    }, miscArt('card_back'));
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

  /** Soft tileable cloud noise for drifting mist. */
  mist(): THREE.Texture {
    const S = 256;
    const tex = this.make('mist', S, S, (g) => {
      g.fillStyle = 'rgba(0,0,0,0)';
      g.fillRect(0, 0, S, S);
      // Many soft blobs, wrapped at the edges so the texture tiles.
      let h = 1337;
      const rnd = () => ((h = (h * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 70; i++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 20 + rnd() * 50;
        const a = 0.04 + rnd() * 0.08;
        for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
          const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          grad.addColorStop(0, `rgba(170,150,130,${a})`);
          grad.addColorStop(1, 'rgba(170,150,130,0)');
          g.fillStyle = grad;
          g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
        }
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /** Soft smoke puff for ruin plumes. */
  smokePuff(): THREE.Texture {
    const S = 64;
    return this.make('smoke-puff', S, S, (g) => {
      const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grad.addColorStop(0, 'rgba(60,50,45,0.85)');
      grad.addColorStop(0.5, 'rgba(40,32,28,0.45)');
      grad.addColorStop(1, 'rgba(20,16,14,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
    });
  }

  /** Glowing runic circle (white; tinted by the material colour). */
  magicCircle(): THREE.Texture {
    const S = 512;
    return this.make('magic-circle', S, S, (g) => {
      const c = S / 2;
      g.strokeStyle = '#ffffff';
      g.fillStyle = '#ffffff';
      g.shadowColor = '#ffffff';
      g.shadowBlur = 12;
      const ring = (r: number, w: number) => { g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.lineWidth = w; g.stroke(); };
      ring(c - 12, 6);
      ring(c - 34, 2);
      ring(c * 0.52, 3);
      ring(c * 0.18, 2);
      // Heptagram — seven points, deliberately not any faction's star.
      const pts = Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
        return [c + Math.cos(a) * (c - 36), c + Math.sin(a) * (c - 36)] as const;
      });
      g.lineWidth = 3;
      g.beginPath();
      for (let i = 0; i <= 7; i++) {
        const [x, y] = pts[(i * 3) % 7]!;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      // Runes around the band.
      const runes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
      g.font = '26px serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        g.save();
        g.translate(c + Math.cos(a) * (c - 23), c + Math.sin(a) * (c - 23));
        g.rotate(a + Math.PI / 2);
        g.fillText(runes[i % runes.length]!, 0, 0);
        g.restore();
      }
    });
  }

  /** Top face of a corruption token: owner's colour with an engraved skull. */
  corruptionFace(power: Power): THREE.Texture {
    const S = 96;
    const color = POWER_COLORS[power];
    return this.make(`corrupt:${power}`, S, S, (g) => {
      const grad = g.createRadialGradient(S * 0.4, S * 0.35, 4, S / 2, S / 2, S / 2);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.18, color);
      grad.addColorStop(1, '#0a0604');
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      g.beginPath();
      g.arc(S / 2, S / 2, S / 2 - 5, 0, Math.PI * 2);
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.stroke();
      g.fillStyle = 'rgba(10,4,2,0.8)';
      g.font = `${S * 0.5}px serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('☠', S / 2, S / 2 + 2);
    });
  }

  /** Scorched earth with glowing fissures, laid over a ruined region. */
  ruinDecal(seed: string): THREE.Texture {
    const W = 512;
    const H = 360;
    return this.make(`ruin:${seed}`, W, H, (g) => {
      let h = 0;
      for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      const rnd = () => {
        h = (h + 0x6d2b79f5) >>> 0;
        let t = h;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const burn = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.55);
      burn.addColorStop(0, 'rgba(20,4,2,0.92)');
      burn.addColorStop(0.7, 'rgba(30,8,4,0.75)');
      burn.addColorStop(1, 'rgba(30,8,4,0)');
      g.fillStyle = burn;
      g.fillRect(0, 0, W, H);
      const crack = (x: number, y: number, a: number, len: number, width: number, depth: number) => {
        g.beginPath();
        g.moveTo(x, y);
        const steps = 6 + Math.floor(rnd() * 5);
        for (let i = 0; i < steps; i++) {
          a += (rnd() - 0.5) * 0.9;
          const step = (len / steps) * (0.6 + rnd() * 0.8);
          x += Math.cos(a) * step;
          y += Math.sin(a) * step;
          g.lineTo(x, y);
          if (depth < 2 && rnd() < 0.28) {
            g.stroke();
            crack(x, y, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6), len * 0.45, width * 0.6, depth + 1);
            g.beginPath();
            g.moveTo(x, y);
          }
        }
        g.lineWidth = width;
        g.stroke();
      };
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [color, blur, widthK] of [['#ff3a0a', 18, 2.2], ['#ffb060', 6, 1], ['#fff0c0', 0, 0.35]] as const) {
        const save = h;
        g.strokeStyle = color;
        g.shadowColor = color;
        g.shadowBlur = blur;
        for (let i = 0; i < 7; i++) crack(W / 2, H / 2, (i / 7) * Math.PI * 2 + rnd() * 0.5, W * 0.42, 5 * widthK, 0);
        h = save;
      }
      g.shadowBlur = 0;
    });
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
