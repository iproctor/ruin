import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Phase, Power } from '@ruin/engine';
import { SoundEngine } from '../sfx.js';

// Minimal WebAudio stand-in: every node/param method exists and is a no-op,
// so this exercises all effect graphs for typos or bad node wiring.
function param() {
  return {
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; },
  };
}
function node(extra: Record<string, unknown> = {}) {
  return {
    connect() { return this; },
    disconnect() {},
    start() {},
    stop() {},
    gain: param(),
    frequency: param(),
    detune: param(),
    Q: param(),
    threshold: param(),
    ratio: param(),
    type: 'sine',
    buffer: null as unknown,
    loop: false,
    ...extra,
  };
}
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = node();
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createGain() { return node(); }
  createOscillator() { return node(); }
  createBiquadFilter() { return node(); }
  createDynamicsCompressor() { return node(); }
  createConvolver() { return node(); }
  createBufferSource() { return node(); }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (c: number) => data[c]! };
  }
}

describe('SoundEngine', () => {
  const g = globalThis as unknown as { window: Record<string, unknown> };
  let prev: unknown;
  beforeAll(() => {
    prev = g.window['AudioContext'];
    g.window['AudioContext'] = FakeAudioContext;
  });
  afterAll(() => {
    g.window['AudioContext'] = prev;
  });

  it('plays every effect without throwing', () => {
    const s = new SoundEngine();
    s.musicEnabled = false;
    s.unlock();
    const powers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
    const phases: Phase[] = ['world', 'draw', 'summoning', 'battle', 'corruption', 'end'];
    expect(() => {
      s.click(); s.hover(); s.cardDraw(); s.move(); s.diceRattle(6); s.diceLand(true); s.diceLand(false);
      s.diceExplode(); s.hit(); s.kill(); s.miss(); s.battleHorn(); s.ruination(); s.vp(); s.worldCard();
      s.yourTurn(); s.victory(true); s.victory(false);
      for (const p of powers) { s.cardPlay(p); s.spellImpact(p); s.summon(p); s.corruption(p); s.domination(p); s.dial(p); }
      for (const ph of phases) { s.phase(ph); s.setMusicPhase(ph); }
      s.setVolume(0.3);
      s.setEnabled(false);
      s.setEnabled(true);
      s.dispose();
    }).not.toThrow();
  });

  it('stays silent when disabled', () => {
    const s = new SoundEngine();
    s.enabled = false;
    expect(() => s.kill()).not.toThrow();
  });
});
