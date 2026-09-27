import type { Power } from '@ruin/engine';

/**
 * Lightweight 2D particle engine for spell, battle and ruination effects.
 * Renders into one full-viewport canvas; the RAF loop only runs while
 * particles are alive.
 */

type Shape = 'glow' | 'spark' | 'smoke' | 'ring' | 'petal' | 'rune' | 'fly' | 'shock' | 'debris';

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  ax: number; ay: number;
  drag: number;
  life: number; maxLife: number;
  size: number; grow: number;
  color: string;
  alpha: number;
  shape: Shape;
  rot: number; vrot: number;
  additive: boolean;
  glyph?: string;
  delay: number;
}

export type BurstKind =
  | 'spell' | 'summon' | 'corrupt' | 'hit' | 'kill' | 'ruin' | 'dust' | 'gold' | 'explode' | 'teleport_out' | 'aura';

const PALETTE: Record<Power, string[]> = {
  xarm: ['#ff3b2f', '#ff7a2f', '#ffb347', '#c21818', '#e0a060'],
  gormen: ['#9ebe48', '#c7e36a', '#6f8f2a', '#d8e89a', '#4f6a1c'],
  tenzen: ['#2daade', '#7fd4ff', '#ff5fd2', '#b98cff', '#e8f6ff'],
  lasha: ['#a855f7', '#ff5fb8', '#f0a6ff', '#ff9ad5', '#7a2f98'],
};
const RUNES = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]!;

export class ParticleSystem {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private raf = 0;
  private last = 0;
  private sprites = new Map<string, HTMLCanvasElement>();
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * this.dpr;
    this.canvas.height = window.innerHeight * this.dpr;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.particles = [];
  }

  private glowSprite(color: string): HTMLCanvasElement {
    let s = this.sprites.get(color);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.5, color + '55');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(color, s);
    return s;
  }

  private smokeSprite(color: string): HTMLCanvasElement {
    const key = 'smoke' + color;
    let s = this.sprites.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color + 'aa');
    grad.addColorStop(0.6, color + '44');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(key, s);
    return s;
  }

  private add(p: Partial<Particle> & { x: number; y: number }) {
    this.particles.push({
      vx: 0, vy: 0, ax: 0, ay: 0, drag: 0.98,
      life: 0, maxLife: 1, size: 6, grow: 0,
      color: '#fff', alpha: 1, shape: 'glow',
      rot: 0, vrot: 0, additive: true, delay: 0,
      ...p,
    });
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  // ── Recipes ────────────────────────────────────────────────────────────────

  burst(x: number, y: number, kind: BurstKind, power: Power | null = null, scale = 1) {
    const pal = power ? PALETTE[power] : ['#ffd79a', '#ffb347', '#fff1c9'];
    const s = scale;
    switch (kind) {
      case 'spell':
        this.shock(x, y, pal[0]!, 120 * s);
        this.shock(x, y, pal[1]!, 70 * s, 0.12);
        this.powerFlavor(x, y, power, 1.2 * s);
        for (let i = 0; i < 40 * s; i++) {
          const a = rand(0, Math.PI * 2);
          const v = rand(80, 320) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.93, maxLife: rand(0.5, 1.1), size: rand(3, 7) * s, color: pick(pal), shape: 'glow' });
        }
        break;
      case 'aura':
        this.powerFlavor(x, y, power, 0.7 * s);
        break;
      case 'summon': {
        this.shock(x, y, pal[0]!, 60 * s);
        for (let i = 0; i < 26 * s; i++) {
          const a = rand(0, Math.PI * 2);
          const r = rand(4, 22) * s;
          this.add({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.5, vx: Math.cos(a) * 20, vy: rand(-140, -40) * s, drag: 0.95, maxLife: rand(0.5, 1.0), size: rand(3, 6) * s, color: pick(pal) });
        }
        for (let i = 0; i < 8; i++) {
          this.add({ x: x + rand(-14, 14) * s, y: y + rand(-4, 6) * s, vx: rand(-20, 20), vy: rand(-30, -8), maxLife: rand(0.9, 1.5), size: rand(14, 26) * s, grow: 18, color: '#2a2320', shape: 'smoke', additive: false, alpha: 0.7 });
        }
        break;
      }
      case 'corrupt':
        for (let i = 0; i < 18 * s; i++) {
          this.add({ x: x + rand(-10, 10), y: y + rand(-6, 6), vx: rand(-40, 40), vy: rand(-90, -20), drag: 0.96, maxLife: rand(0.6, 1.2), size: rand(3, 6), color: pick(pal) });
        }
        this.add({ x, y, maxLife: 0.6, size: 36 * s, grow: 60, color: pal[0]!, shape: 'glow', alpha: 0.6 });
        break;
      case 'hit':
        this.shock(x, y, '#ffcf8a', 46 * s);
        for (let i = 0; i < 22 * s; i++) {
          const a = rand(0, Math.PI * 2);
          const v = rand(160, 460) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ay: 300, drag: 0.9, maxLife: rand(0.25, 0.55), size: rand(1.5, 3), color: pick(['#fff1c9', '#ffb347', '#ff7a2f']), shape: 'spark' });
        }
        break;
      case 'kill':
        this.shock(x, y, '#ff3b2f', 80 * s);
        for (let i = 0; i < 26 * s; i++) {
          const a = rand(-Math.PI, 0);
          const v = rand(120, 380) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ay: 900, drag: 0.97, maxLife: rand(0.6, 1.2), size: rand(2, 5) * s, color: pick(['#3b2a20', '#5a4028', '#2a1d14', '#7a6048']), shape: 'debris', additive: false, vrot: rand(-10, 10) });
        }
        for (let i = 0; i < 18 * s; i++) {
          const a = rand(0, Math.PI * 2);
          const v = rand(60, 220) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.92, maxLife: rand(0.4, 0.9), size: rand(3, 7) * s, color: pick(['#ff3b2f', '#c21818', '#ff7a2f']) });
        }
        for (let i = 0; i < 5; i++) {
          this.add({ x: x + rand(-10, 10), y: y + rand(-10, 10), vx: rand(-20, 20), vy: rand(-40, -10), maxLife: rand(1, 1.6), size: rand(16, 26) * s, grow: 20, color: '#1a1210', shape: 'smoke', additive: false, alpha: 0.75 });
        }
        break;
      case 'explode':
        this.shock(x, y, '#ffe08a', 50 * s);
        for (let i = 0; i < 30; i++) {
          const a = rand(0, Math.PI * 2);
          const v = rand(100, 300) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.9, maxLife: rand(0.4, 0.8), size: rand(2, 5), color: pick(['#fff1c9', '#ffd060', '#ff9a3a']) });
        }
        break;
      case 'ruin':
        this.shock(x, y, '#ff3b2f', 260 * s);
        this.shock(x, y, '#ffb347', 170 * s, 0.1);
        this.shock(x, y, '#ffffff', 90 * s, 0.05);
        for (let i = 0; i < 120 * s; i++) {
          const a = rand(-Math.PI, 0);
          const v = rand(100, 520) * s;
          this.add({ x: x + rand(-40, 40) * s, y: y + rand(-20, 20) * s, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ay: 700, drag: 0.98, maxLife: rand(0.8, 1.8), size: rand(2, 7) * s, color: pick(['#3b2a20', '#5a4028', '#2a1d14']), shape: 'debris', additive: false, vrot: rand(-8, 8) });
        }
        for (let i = 0; i < 140 * s; i++) {
          this.add({ x: x + rand(-70, 70) * s, y: y + rand(-30, 30) * s, vx: rand(-60, 60), vy: rand(-260, -40), drag: 0.97, maxLife: rand(0.8, 2.4), size: rand(2, 6), color: pick(['#ff3b2f', '#ff7a2f', '#ffb347', '#ffe08a']), delay: rand(0, 0.6) });
        }
        for (let i = 0; i < 26; i++) {
          this.add({ x: x + rand(-60, 60) * s, y: y + rand(-20, 30) * s, vx: rand(-40, 40), vy: rand(-80, -20), maxLife: rand(1.8, 3.2), size: rand(30, 60) * s, grow: 40, color: '#140c08', shape: 'smoke', additive: false, alpha: 0.85, delay: rand(0, 0.5) });
        }
        break;
      case 'dust':
        for (let i = 0; i < 10; i++) {
          this.add({ x: x + rand(-12, 12), y: y + rand(0, 6), vx: rand(-50, 50), vy: rand(-30, -5), drag: 0.93, maxLife: rand(0.5, 0.9), size: rand(8, 14), grow: 20, color: '#6b5c4c', shape: 'smoke', additive: false, alpha: 0.5 });
        }
        break;
      case 'gold':
        for (let i = 0; i < 30 * s; i++) {
          const a = rand(-Math.PI, 0);
          const v = rand(60, 220) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ay: 160, drag: 0.96, maxLife: rand(0.7, 1.4), size: rand(2, 4), color: pick(['#ffe08a', '#ffd060', '#fff1c9', '#c68c5a']), shape: 'spark' });
        }
        break;
      case 'teleport_out':
        for (let i = 0; i < 30; i++) {
          const a = rand(0, Math.PI * 2);
          const r = rand(2, 16);
          this.add({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, vx: -Math.sin(a) * 120, vy: Math.cos(a) * 120 - 40, drag: 0.94, maxLife: rand(0.4, 0.9), size: rand(2, 5), color: pick(PALETTE.tenzen) });
        }
        break;
    }
  }

  /** A travelling mote from a to b (corruption tokens, siphons). */
  trail(x0: number, y0: number, x1: number, y1: number, color: string, count = 10, duration = 0.7) {
    for (let i = 0; i < count; i++) {
      const d = duration * rand(0.85, 1.15);
      const delay = i * 0.03;
      this.add({ x: x0, y: y0, vx: (x1 - x0) / d, vy: (y1 - y0) / d, drag: 1, maxLife: d, size: rand(3, 6), color, delay });
    }
  }

  private shock(x: number, y: number, color: string, radius: number, delay = 0) {
    this.add({ x, y, maxLife: 0.55, size: radius * 0.15, grow: radius * 2.2, color, shape: 'shock', delay, alpha: 0.9 });
  }

  private powerFlavor(x: number, y: number, power: Power | null, s: number) {
    if (!power) return;
    const pal = PALETTE[power];
    switch (power) {
      case 'xarm':
        // Rising fire embers and brass sparks.
        for (let i = 0; i < 50 * s; i++) {
          this.add({ x: x + rand(-40, 40) * s, y: y + rand(-10, 20) * s, vx: rand(-40, 40), vy: rand(-280, -80) * s, drag: 0.97, maxLife: rand(0.6, 1.4), size: rand(2, 5), color: pick(pal), delay: rand(0, 0.3) });
        }
        for (let i = 0; i < 14 * s; i++) {
          this.add({ x, y, vx: rand(-300, 300) * s, vy: rand(-300, 100) * s, ay: 500, drag: 0.96, maxLife: rand(0.4, 0.8), size: rand(1.5, 2.5), color: '#ffe08a', shape: 'spark' });
        }
        break;
      case 'gormen':
        // Bubbles, miasma and buzzing flies.
        for (let i = 0; i < 26 * s; i++) {
          this.add({ x: x + rand(-40, 40) * s, y: y + rand(-10, 20) * s, vx: rand(-20, 20), vy: rand(-90, -30) * s, drag: 0.98, maxLife: rand(0.8, 1.6), size: rand(3, 9) * s, color: pick(pal), shape: 'ring', additive: false, alpha: 0.9, delay: rand(0, 0.4) });
        }
        for (let i = 0; i < 10; i++) {
          this.add({ x: x + rand(-30, 30) * s, y: y + rand(-15, 15) * s, vx: rand(-30, 30), vy: rand(-40, 0), maxLife: rand(1.2, 2.2), size: rand(24, 40) * s, grow: 30, color: '#3f5a14', shape: 'smoke', additive: false, alpha: 0.55 });
        }
        for (let i = 0; i < 14 * s; i++) {
          this.add({ x: x + rand(-30, 30) * s, y: y + rand(-30, 10) * s, maxLife: rand(1, 1.8), size: 1.8, color: '#141a08', shape: 'fly', additive: false });
        }
        break;
      case 'tenzen':
        // Spiralling arcane motes and floating runes.
        for (let i = 0; i < 40 * s; i++) {
          const a = (i / (40 * s)) * Math.PI * 4;
          const r = 10 + i * 1.6;
          this.add({ x: x + Math.cos(a) * r * s, y: y + Math.sin(a) * r * 0.6 * s, vx: -Math.sin(a) * 90, vy: Math.cos(a) * 60 - 40, drag: 0.96, maxLife: rand(0.7, 1.3), size: rand(2, 5), color: pick(pal), delay: i * 0.008 });
        }
        for (let i = 0; i < 9 * s; i++) {
          this.add({ x: x + rand(-50, 50) * s, y: y + rand(-30, 20) * s, vy: rand(-50, -15), maxLife: rand(1, 1.6), size: rand(12, 18) * s, color: pick(pal), shape: 'rune', glyph: pick([...RUNES]), vrot: rand(-1, 1), delay: rand(0, 0.3) });
        }
        break;
      case 'lasha':
        // Drifting petals and perfumed haze.
        for (let i = 0; i < 34 * s; i++) {
          const a = rand(0, Math.PI * 2);
          const v = rand(40, 180) * s;
          this.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, ay: 40, drag: 0.95, maxLife: rand(1, 2), size: rand(4, 8) * s, color: pick(pal), shape: 'petal', additive: false, vrot: rand(-6, 6), rot: rand(0, 6), delay: rand(0, 0.25) });
        }
        for (let i = 0; i < 10; i++) {
          this.add({ x: x + rand(-30, 30) * s, y: y + rand(-15, 15) * s, vx: rand(-30, 30), vy: rand(-30, 0), maxLife: rand(1.4, 2.4), size: rand(24, 44) * s, grow: 30, color: '#b8307a', shape: 'smoke', alpha: 0.4 });
        }
        break;
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const alive: Particle[] = [];
    for (const p of this.particles) {
      if (p.delay > 0) { p.delay -= dt; alive.push(p); continue; }
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      alive.push(p);
      p.vx = (p.vx + p.ax * dt) * Math.pow(p.drag, dt * 60);
      p.vy = (p.vy + p.ay * dt) * Math.pow(p.drag, dt * 60);
      if (p.shape === 'fly') { p.vx += rand(-900, 900) * dt; p.vy += rand(-900, 900) * dt; p.vx *= 0.9; p.vy *= 0.9; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.size += p.grow * dt;
      const t = p.life / p.maxLife;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.globalAlpha = Math.max(0, fade * p.alpha);
      ctx.globalCompositeOperation = p.additive ? 'lighter' : 'source-over';
      this.draw(p);
    }
    this.particles = alive;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (alive.length > 0) this.raf = requestAnimationFrame(this.tick);
    else {
      this.raf = 0;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  private draw(p: Particle) {
    const ctx = this.ctx;
    const s = p.size;
    switch (p.shape) {
      case 'glow':
        ctx.drawImage(this.glowSprite(p.color), p.x - s * 2, p.y - s * 2, s * 4, s * 4);
        break;
      case 'smoke':
        ctx.drawImage(this.smokeSprite(p.color), p.x - s, p.y - s, s * 2, s * 2);
        break;
      case 'spark': {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
        break;
      }
      case 'ring':
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'shock': {
        const t = p.life / p.maxLife;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.5, 10 * (1 - t));
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, s, s * 0.62, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'petal':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      case 'rune':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.font = `${s}px serif`;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.textAlign = 'center';
        ctx.fillText(p.glyph ?? '*', 0, s / 3);
        ctx.restore();
        break;
      case 'fly':
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, s, s);
        break;
      case 'debris':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-s / 2, -s / 2, s, s * 0.7);
        ctx.restore();
        break;
    }
  }
}
