import type { Phase, Power } from '@ruin/engine';

export interface MusicTrack {
  url: string;
  /** Seconds into the decoded buffer where the seamless loop begins/ends. */
  loopStart: number;
  loopEnd: number;
}

/** Background music level relative to the master volume. */
const MUSIC_GAIN = 0.55;

/**
 * Sound engine: every effect is synthesized with WebAudio; the only asset is
 * the looping background track. One instance per game page (see SoundContext).
 *
 * Signal chain:  voices → dry bus ─┐
 *                        → reverb ─┴→ master gain → compressor → out
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private musicBus!: GainNode;
  private music: MusicTrack | null;
  private musicBuffer: Promise<AudioBuffer> | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicWanted = false;

  constructor(music: MusicTrack | null = null) {
    this.music = music;
  }

  enabled = true;
  musicEnabled = true;
  volume = 0.7;

  /** Lazily create the context; browsers only allow it after a user gesture. */
  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);

    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(2.8, 2.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.9;
    this.wet.connect(reverb);
    reverb.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /** Call from a user-gesture handler so later sounds are allowed to play. */
  unlock() {
    const ctx = this.ensure();
    if (ctx && this.musicEnabled && this.enabled) this.startMusic();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.stopMusic();
    else if (this.musicEnabled && this.ctx) this.startMusic();
  }

  setMusic(on: boolean) {
    this.musicEnabled = on;
    if (on && this.enabled && this.ctx) this.startMusic();
    else this.stopMusic();
  }

  dispose() {
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }

  // ── Building blocks ────────────────────────────────────────────────────────

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private out(node: AudioNode, wet = 0.25) {
    node.connect(this.dry);
    if (wet > 0) {
      const g = this.ctx!.createGain();
      g.gain.value = wet;
      node.connect(g);
      g.connect(this.wet);
    }
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(freq: number, type: OscillatorType, t: number, peak: number, attack: number, decay: number, wet = 0.3, detune = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    this.env(g, t, peak, attack, decay);
    o.connect(g);
    this.out(g, wet);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    return o;
  }

  private noiseBurst(t: number, dur: number, peak: number, filterType: BiquadFilterType, f0: number, f1: number, q = 1, wet = 0.2) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, Math.min(0.02, dur / 4), dur);
    src.connect(f);
    f.connect(g);
    this.out(g, wet);
    src.start(t, Math.random());
    src.stop(t + dur + 0.1);
  }

  private thump(t: number, f0: number, f1: number, dur: number, peak: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, 0.005, dur);
    o.connect(g);
    this.out(g, 0.15);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private bell(t: number, freq: number, peak: number, decay: number) {
    // Inharmonic partials of a church bell.
    [1, 2.0, 2.76, 5.4, 8.93].forEach((r, i) => {
      this.tone(freq * r, 'sine', t, peak / (i + 1), 0.004, decay / (1 + i * 0.4), 0.5);
    });
  }

  private play(fn: (ctx: AudioContext, t: number) => void) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    fn(ctx, ctx.currentTime + 0.01);
  }

  // ── Power signatures ──────────────────────────────────────────────────────

  private signature(power: Power, t: number, strength = 1) {
    switch (power) {
      case 'xarm': {
        // Brass war stab: stacked fifths on saws through a closing lowpass.
        const ctx = this.ctx!;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(2400, t);
        f.frequency.exponentialRampToValueAtTime(300, t + 0.7);
        const g = ctx.createGain();
        this.env(g, t, 0.18 * strength, 0.02, 0.8);
        f.connect(g);
        this.out(g, 0.35);
        for (const [fr, dt] of [[73.4, 0], [110, 7], [146.8, -6], [220, 4]] as const) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = fr;
          o.detune.value = dt;
          o.connect(f);
          o.start(t);
          o.stop(t + 0.9);
        }
        this.thump(t, 90, 40, 0.4, 0.5 * strength);
        break;
      }
      case 'gormen': {
        // Wet bubbling: short sine blips with upward pitch bends.
        for (let i = 0; i < 7; i++) {
          const tt = t + i * 0.06 + Math.random() * 0.04;
          const ctx = this.ctx!;
          const o = ctx.createOscillator();
          o.type = 'sine';
          const base = 180 + Math.random() * 260;
          o.frequency.setValueAtTime(base, tt);
          o.frequency.exponentialRampToValueAtTime(base * 2.2, tt + 0.07);
          const g = ctx.createGain();
          this.env(g, tt, 0.14 * strength, 0.005, 0.08);
          o.connect(g);
          this.out(g, 0.3);
          o.start(tt);
          o.stop(tt + 0.12);
        }
        this.noiseBurst(t, 0.6, 0.08 * strength, 'lowpass', 900, 200, 4, 0.3);
        this.tone(55, 'triangle', t, 0.2 * strength, 0.05, 0.9, 0.2, 0);
        break;
      }
      case 'tenzen': {
        // Glittering arpeggio in a whole-tone scale.
        const scale = [523.3, 587.3, 659.3, 740, 830.6, 932.3, 1046.5, 1174.7];
        for (let i = 0; i < 6; i++) {
          const fr = scale[(i * 3) % scale.length]! * (i > 3 ? 2 : 1);
          this.tone(fr, 'triangle', t + i * 0.055, 0.08 * strength, 0.005, 0.6, 0.7);
        }
        this.noiseBurst(t, 0.5, 0.05 * strength, 'highpass', 4000, 9000, 1, 0.6);
        break;
      }
      case 'lasha': {
        // Breathy, tremolo minor-major chord with a sighing noise swell.
        const ctx = this.ctx!;
        const trem = ctx.createOscillator();
        trem.frequency.value = 7;
        const tremGain = ctx.createGain();
        tremGain.gain.value = 0.05 * strength;
        trem.connect(tremGain);
        const g = ctx.createGain();
        this.env(g, t, 0.1 * strength, 0.15, 1.1);
        tremGain.connect(g.gain);
        this.out(g, 0.6);
        for (const fr of [311.1, 392, 466.2, 587.3]) {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = fr;
          o.detune.value = (Math.random() - 0.5) * 18;
          o.connect(g);
          o.start(t);
          o.stop(t + 1.4);
        }
        trem.start(t);
        trem.stop(t + 1.4);
        this.noiseBurst(t, 0.9, 0.06 * strength, 'bandpass', 600, 2400, 2, 0.5);
        break;
      }
    }
  }

  // ── Public effects ────────────────────────────────────────────────────────

  click() {
    this.play((_c, t) => this.noiseBurst(t, 0.04, 0.08, 'bandpass', 2400, 1800, 3, 0));
  }

  hover() {
    this.play((_c, t) => this.tone(1400, 'sine', t, 0.015, 0.003, 0.05, 0));
  }

  cardDraw() {
    this.play((_c, t) => {
      this.noiseBurst(t, 0.18, 0.12, 'bandpass', 1200, 4000, 1.5, 0.1);
    });
  }

  cardPlay(power: Power) {
    this.play((_c, t) => {
      this.noiseBurst(t, 0.35, 0.16, 'bandpass', 400, 3200, 1.2, 0.2);
      this.signature(power, t + 0.12, 1);
    });
  }

  spellImpact(power: Power) {
    this.play((_c, t) => {
      this.thump(t, 140, 35, 0.5, 0.5);
      this.signature(power, t, 0.6);
    });
  }

  summon(power: Power) {
    this.play((_c, t) => {
      this.thump(t, 110, 35, 0.35, 0.55);
      this.noiseBurst(t, 0.3, 0.1, 'lowpass', 2000, 200, 1, 0.3);
      this.signature(power, t + 0.05, 0.45);
    });
  }

  move() {
    this.play((_c, t) => {
      this.noiseBurst(t, 0.25, 0.1, 'bandpass', 300, 1400, 2, 0.1);
      this.thump(t + 0.2, 80, 40, 0.2, 0.3);
    });
  }

  diceRattle(count: number) {
    this.play((_c, t) => {
      const clicks = 8 + count * 4;
      for (let i = 0; i < clicks; i++) {
        const tt = t + Math.pow(i / clicks, 1.4) * 0.75;
        this.noiseBurst(tt, 0.025, 0.12 + Math.random() * 0.1, 'bandpass', 1800 + Math.random() * 2400, 1200, 5, 0.05);
      }
    });
  }

  diceLand(hit: boolean) {
    this.play((_c, t) => {
      this.thump(t, 220, 90, 0.08, 0.3);
      this.noiseBurst(t, 0.05, 0.12, 'bandpass', 1500, 900, 4, 0.05);
      if (hit) this.tone(880, 'triangle', t + 0.02, 0.05, 0.005, 0.25, 0.4);
    });
  }

  diceExplode() {
    this.play((_c, t) => {
      this.noiseBurst(t, 0.4, 0.2, 'highpass', 800, 6000, 1, 0.4);
      this.tone(1320, 'sine', t, 0.08, 0.005, 0.5, 0.6);
      this.tone(1760, 'sine', t + 0.06, 0.06, 0.005, 0.5, 0.6);
    });
  }

  hit() {
    this.play((_c, t) => {
      this.thump(t, 160, 40, 0.3, 0.7);
      this.noiseBurst(t, 0.18, 0.3, 'lowpass', 3000, 400, 1, 0.2);
    });
  }

  kill() {
    this.play((ctx, t) => {
      this.thump(t, 120, 30, 0.6, 0.9);
      this.noiseBurst(t, 0.45, 0.35, 'lowpass', 5000, 150, 0.8, 0.35);
      // Metallic ring (FM).
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      car.frequency.value = 330;
      mod.frequency.value = 330 * 1.414;
      modGain.gain.value = 600;
      mod.connect(modGain);
      modGain.connect(car.frequency);
      const g = ctx.createGain();
      this.env(g, t, 0.06, 0.003, 0.7);
      car.connect(g);
      this.out(g, 0.6);
      car.start(t); mod.start(t);
      car.stop(t + 0.8); mod.stop(t + 0.8);
    });
  }

  miss() {
    this.play((_c, t) => this.noiseBurst(t, 0.25, 0.06, 'bandpass', 2000, 500, 2, 0.2));
  }

  battleHorn() {
    this.play((ctx, t) => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(300, t);
      f.frequency.linearRampToValueAtTime(1400, t + 0.5);
      f.frequency.linearRampToValueAtTime(500, t + 1.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.25);
      g.gain.setValueAtTime(0.22, t + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      f.connect(g);
      this.out(g, 0.5);
      for (const [fr, dt] of [[98, 0], [98, 9], [147, -5]] as const) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(fr * 0.94, t);
        o.frequency.linearRampToValueAtTime(fr, t + 0.2);
        o.detune.value = dt;
        o.connect(f);
        o.start(t);
        o.stop(t + 1.9);
      }
      this.drums(t, 3, 0.32);
    });
  }

  private drums(t: number, n: number, gap: number) {
    for (let i = 0; i < n; i++) {
      this.thump(t + i * gap, 95, 38, 0.45, 0.8);
      this.noiseBurst(t + i * gap, 0.12, 0.12, 'lowpass', 900, 200, 1, 0.3);
    }
  }

  corruption(power: Power) {
    this.play((ctx, t) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(55, t);
      o.frequency.exponentialRampToValueAtTime(41, t + 0.8);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(200, t);
      f.frequency.exponentialRampToValueAtTime(900, t + 0.35);
      f.frequency.exponentialRampToValueAtTime(150, t + 0.9);
      const g = ctx.createGain();
      this.env(g, t, 0.14, 0.2, 0.7);
      o.connect(f); f.connect(g);
      this.out(g, 0.4);
      o.start(t); o.stop(t + 1);
      this.signature(power, t + 0.1, 0.25);
    });
  }

  domination(power: Power) {
    this.play((_c, t) => {
      this.bell(t, 196, 0.12, 2.2);
      this.signature(power, t, 0.8);
      this.noiseBurst(t, 1.2, 0.06, 'highpass', 6000, 9000, 1, 0.6);
    });
  }

  ruination() {
    this.play((ctx, t) => {
      this.thump(t, 70, 22, 2.6, 1);
      this.noiseBurst(t, 3.2, 0.5, 'lowpass', 1600, 40, 0.7, 0.6);
      this.noiseBurst(t + 0.05, 0.6, 0.3, 'highpass', 2500, 800, 1, 0.5);
      // Descending doom chord.
      for (const fr of [65.4, 77.8, 98, 130.8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(fr, t + 0.2);
        o.frequency.exponentialRampToValueAtTime(fr * 0.7, t + 3);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 500;
        const g = ctx.createGain();
        this.env(g, t + 0.2, 0.07, 0.4, 2.6);
        o.connect(f); f.connect(g);
        this.out(g, 0.7);
        o.start(t + 0.2); o.stop(t + 3.3);
      }
      this.bell(t + 0.4, 55, 0.2, 4);
    });
  }

  vp() {
    this.play((_c, t) => {
      this.tone(988, 'triangle', t, 0.06, 0.005, 0.3, 0.4);
      this.tone(1319, 'triangle', t + 0.08, 0.06, 0.005, 0.5, 0.4);
    });
  }

  dial(power: Power) {
    this.play((_c, t) => {
      for (let i = 0; i < 3; i++) this.noiseBurst(t + i * 0.07, 0.03, 0.15, 'bandpass', 3000, 2500, 8, 0.05);
      this.signature(power, t + 0.2, 0.35);
    });
  }

  worldCard() {
    this.play((ctx, t) => {
      this.noiseBurst(t, 0.3, 0.14, 'bandpass', 800, 3000, 1.3, 0.2);
      // Distant horn.
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      const g = ctx.createGain();
      this.env(g, t + 0.15, 0.1, 0.3, 1.4);
      f.connect(g);
      this.out(g, 0.8);
      for (const fr of [130.8, 196]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = fr;
        o.connect(f);
        o.start(t + 0.15);
        o.stop(t + 1.9);
      }
    });
  }

  yourTurn() {
    this.play((_c, t) => {
      this.bell(t, 392, 0.1, 1.6);
      this.bell(t + 0.18, 523.3, 0.08, 1.8);
    });
  }

  phase(phase: Phase) {
    this.play((_c, t) => {
      switch (phase) {
        case 'battle': this.drums(t, 4, 0.22); this.bell(t, 73.4, 0.18, 3); break;
        case 'corruption': this.corruptionChoir(t); break;
        case 'summoning': this.bell(t, 130.8, 0.16, 3.2); break;
        case 'world': this.bell(t, 98, 0.16, 3.2); break;
        case 'end': this.bell(t, 110, 0.12, 2.5); break;
        default: this.bell(t, 146.8, 0.1, 2);
      }
    });
  }

  private corruptionChoir(t: number) {
    const ctx = this.ctx!;
    // Formant-filtered saws approximate a low "ahh".
    const formants = [700, 1150, 2400];
    const g = ctx.createGain();
    this.env(g, t, 0.12, 0.6, 2);
    this.out(g, 0.8);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    for (const ff of formants) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = ff;
      f.Q.value = 8;
      bus.connect(f);
      f.connect(g);
    }
    for (const fr of [110, 130.8, 164.8, 110.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = (Math.random() - 0.5) * 20;
      o.connect(bus);
      o.start(t);
      o.stop(t + 2.8);
    }
  }

  victory(isMine: boolean) {
    this.play((_c, t) => {
      const chord = isMine ? [261.6, 329.6, 392, 523.3] : [220, 261.6, 329.6, 440];
      chord.forEach((fr, i) => this.tone(fr, 'sawtooth', t + i * 0.12, 0.05, 0.3, 3, 0.8, (Math.random() - 0.5) * 10));
      this.bell(t, 130.8, 0.2, 5);
      this.drums(t, 3, 0.4);
    });
  }

  // ── Background music ──────────────────────────────────────────────────────

  /** Fetch + decode the track once; later calls reuse the same promise. */
  private loadMusic(ctx: AudioContext): Promise<AudioBuffer> | null {
    if (!this.music) return null;
    if (!this.musicBuffer) {
      const url = this.music.url;
      this.musicBuffer = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data));
      this.musicBuffer.catch(() => { this.musicBuffer = null; });
    }
    return this.musicBuffer;
  }

  private startMusic() {
    const ctx = this.ctx;
    this.musicWanted = true;
    if (!ctx || this.musicSource || !this.music) return;
    const loading = this.loadMusic(ctx);
    if (!loading) return;
    const track = this.music;
    loading.then((buffer) => {
      // Settings may have changed while decoding.
      if (!this.musicWanted || this.musicSource || this.ctx !== ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = track.loopStart;
      src.loopEnd = Math.min(track.loopEnd, buffer.duration);
      src.connect(this.musicBus);
      src.start();
      this.musicSource = src;
      this.musicBus.gain.cancelScheduledValues(ctx.currentTime);
      this.musicBus.gain.setTargetAtTime(MUSIC_GAIN, ctx.currentTime, 1.5);
    }).catch(() => { /* no music on decode/network failure */ });
  }

  private stopMusic() {
    this.musicWanted = false;
    const ctx = this.ctx;
    const src = this.musicSource;
    this.musicSource = null;
    if (!ctx || !src) return;
    this.musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    setTimeout(() => {
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
    }, 2000);
  }
}
