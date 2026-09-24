// Every sound is synthesized with WebAudio: oscillators plus a generated
// noise buffer. No audio files.

import type { PowerupKind } from '../shared/types.js';

interface ChargeVoice {
  osc: OscillatorNode;
  osc2: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

const MUTE_KEY = 'recoil-muted';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly voices = new Map<number, ChargeVoice>();
  private muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Browsers only allow audio after a user gesture, so call this from one. */
  unlock(): void {
    let ctx = this.ctx;
    if (!ctx) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      comp.connect(ctx.destination);
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.8;
      master.connect(comp);
      // One second of white noise, reused by every noisy sound.
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
    }
    if (ctx.state === 'suspended') void ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // Storage may be unavailable (private mode); muting still works this session.
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  private out(pan: number): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    return p;
  }

  private env(gain: GainNode, t0: number, attack: number, peak: number, decay: number): void {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, pan = 0, delay = 0): void {
    const ctx = this.ctx;
    const dest = this.out(pan);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    this.env(g, t0, 0.004, vol, dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noiseBurst(filter: BiquadFilterType, f0: number, f1: number, q: number, dur: number, vol: number, pan = 0, attack = 0.003): void {
    const ctx = this.ctx;
    const dest = this.out(pan);
    if (!ctx || !dest || !this.noise) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    this.env(g, t0, attack, vol, dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + attack + dur + 0.05);
  }

  /** A few milliseconds of bright noise: the "tick" that makes a sound feel crisp. */
  private click(freq: number, vol: number, pan = 0, dur = 0.012, delay = 0): void {
    const ctx = this.ctx;
    const dest = this.out(pan);
    if (!ctx || !dest || !this.noise) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.02);
  }

  /** Pitch that wobbles like a spring, for bumpers. */
  private boing(f0: number, dur: number, vol: number, pan: number): void {
    const ctx = this.ctx;
    const dest = this.out(pan);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.8, t0 + dur * 0.25);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.9, t0 + dur);
    lfo.frequency.setValueAtTime(28, t0);
    lfo.frequency.linearRampToValueAtTime(12, t0 + dur);
    depth.gain.setValueAtTime(f0 * 0.25, t0);
    depth.gain.exponentialRampToValueAtTime(1, t0 + dur);
    lfo.connect(depth).connect(osc.frequency);
    this.env(g, t0, 0.004, vol, dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + dur + 0.05);
    lfo.stop(t0 + dur + 0.05);
  }

  // -------------------------------------------------------------------------
  // UI sounds
  // -------------------------------------------------------------------------

  /** Short crisp tick for buttons. */
  uiClick(): void {
    this.tone('square', 1900, 1300, 0.025, 0.06);
    this.click(5000, 0.12, 0, 0.008);
  }

  /** Bubbly pop for picking a colour or a map card. */
  uiPop(): void {
    this.tone('sine', 520, 980, 0.07, 0.22);
    this.click(4000, 0.08, 0, 0.006);
  }

  /** Two-note chime for confirming (create, join, start, copy link). */
  uiConfirm(): void {
    this.tone('triangle', 880, 880, 0.09, 0.16);
    this.tone('triangle', 1320, 1320, 0.14, 0.16, 0, 0.07);
    this.click(6000, 0.06, 0, 0.006, 0.07);
  }

  playerJoined(): void {
    this.tone('square', 660, 660, 0.06, 0.06);
    this.tone('square', 990, 990, 0.09, 0.06, 0, 0.07);
  }

  playerLeft(): void {
    this.tone('square', 660, 660, 0.06, 0.05);
    this.tone('square', 440, 440, 0.1, 0.05, 0, 0.07);
  }

  // -------------------------------------------------------------------------
  // Game sounds
  // -------------------------------------------------------------------------

  /** Bright ding the moment your shot is fully charged. */
  chargeFull(): void {
    this.tone('triangle', 1760, 1760, 0.12, 0.14);
    this.tone('sine', 2640, 2640, 0.18, 0.08, 0, 0.02);
    this.click(7000, 0.06, 0, 0.006);
  }

  bumper(force: number, pan: number): void {
    const k = Math.min(1, force / 12);
    this.boing(260 + 120 * k, 0.32, 0.22 + 0.2 * k, pan);
    this.click(3500, 0.18, pan, 0.01);
  }

  /** Springy hop. */
  jump(pan: number, volume = 1): void {
    this.tone('triangle', 240, 520, 0.09, 0.09 * volume, pan);
    this.noiseBurst('bandpass', 900, 2400, 1.2, 0.08, 0.05 * volume, pan);
  }

  /** A shot from a specific weapon (0 Blaster, 1 Scatter, 2 Longshot, 3 Boomer, 4 Pepper). */
  shot(weapon: number, charge: number, pan: number, volume = 1): void {
    switch (weapon) {
      case 1: // Scatter: a fat crack of noise.
        this.noiseBurst('lowpass', 5000, 400, 0.8, 0.22, 0.45 * volume, pan);
        this.tone('square', 180, 60, 0.12, 0.12 * volume, pan);
        this.click(3000, 0.3 * volume, pan, 0.015);
        break;
      case 2: // Longshot: a zap that rises with the charge.
        this.tone('sawtooth', 900 + charge * 1400, 120, 0.18 + charge * 0.12, (0.1 + charge * 0.1) * volume, pan);
        this.tone('sine', 2400, 300, 0.25, 0.08 * volume, pan);
        this.click(7000, 0.2 * volume, pan, 0.01);
        break;
      case 3: // Boomer: a hollow tube thunk.
        this.tone('sine', 220, 70, 0.2, 0.35 * volume, pan);
        this.noiseBurst('bandpass', 600, 200, 1.5, 0.15, 0.15 * volume, pan);
        break;
      case 4: // Pepper: tiny ticks.
        this.tone('square', 1300 + Math.random() * 300, 600, 0.03, 0.05 * volume, pan);
        this.click(6000, 0.08 * volume, pan, 0.006);
        break;
      default:
        this.fire(charge, pan);
    }
  }

  /** A bomb bursting. */
  boom(size: number, pan: number): void {
    const k = Math.min(1, size / 4);
    this.noiseBurst('lowpass', 2400, 90, 0.7, 0.55, 0.5 + 0.2 * k, pan, 0.002);
    this.tone('sine', 120, 35, 0.45, 0.5, pan);
    this.click(2500, 0.25, pan, 0.02);
  }

  /** Jump pad: a springy whoomp. */
  pad(pan: number): void {
    this.boing(180, 0.4, 0.3, pan);
    this.tone('triangle', 300, 1200, 0.25, 0.12, pan);
  }

  /** Sliding: a swish across the roof. */
  slide(pan: number, volume = 1): void {
    this.noiseBurst('bandpass', 1800, 500, 0.9, 0.4, 0.18 * volume, pan, 0.02);
  }

  /** Pulling yourself up a ledge. */
  mantle(pan: number, volume = 1): void {
    this.noiseBurst('bandpass', 700, 1600, 1.2, 0.12, 0.12 * volume, pan);
    this.tone('triangle', 200, 340, 0.1, 0.08 * volume, pan, 0.04);
  }

  /** Soft thump when you land. */
  land(force: number): void {
    const k = Math.min(1, force / 20);
    this.tone('sine', 140, 60, 0.1, 0.1 + 0.2 * k);
    this.noiseBurst('lowpass', 900, 200, 0.7, 0.08, 0.05 + 0.1 * k);
  }

  respawn(pan: number): void {
    this.tone('square', 300, 1200, 0.14, 0.06, pan);
    this.tone('sine', 600, 1800, 0.16, 0.08, pan, 0.03);
  }

  /** Stinger on "FIGHT!": a crash and a bright chord. */
  fight(): void {
    this.noiseBurst('highpass', 6000, 3000, 0.7, 0.35, 0.28, 0, 0.002);
    for (const f of [523, 659, 784, 1047]) this.tone('square', f, f, 0.32, 0.05);
    this.tone('sine', 110, 55, 0.3, 0.45);
    this.click(4000, 0.2, 0, 0.012);
  }

  /** Rising whine while charging. Call every frame; charge 0 silences it. */
  setCharge(id: number, charge: number, pan: number, volume: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let v = this.voices.get(id);
    if (!v) {
      const dest = this.master;
      if (!dest) return;
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      const p = ctx.createStereoPanner();
      osc.type = 'sawtooth';
      osc2.type = 'square';
      osc2.detune.value = 7;
      filter.type = 'lowpass';
      filter.Q.value = 6;
      gain.gain.value = 0;
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(p).connect(dest);
      osc.start();
      osc2.start();
      v = { osc, osc2, filter, gain, pan: p };
      this.voices.set(id, v);
    }
    const t = ctx.currentTime;
    const c = Math.max(0, Math.min(1, charge));
    const wobble = c >= 1 ? 1 + 0.03 * Math.sin(t * 45) : 1;
    const freq = (150 + 600 * Math.pow(c, 1.3)) * wobble;
    v.osc.frequency.setTargetAtTime(freq, t, 0.02);
    v.osc2.frequency.setTargetAtTime(freq * 0.5, t, 0.02);
    v.filter.frequency.setTargetAtTime(500 + 2800 * c, t, 0.03);
    v.gain.gain.setTargetAtTime(c > 0 ? volume * (0.03 + 0.06 * c) : 0, t, c > 0 ? 0.03 : 0.015);
    v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  fire(charge: number, pan: number): void {
    const c = Math.max(0, Math.min(1, charge));
    this.click(4500, 0.35 + 0.2 * c, pan, 0.01);
    this.tone('sine', 160 + 60 * c, 40, 0.14 + 0.1 * c, 0.5 + 0.4 * c, pan);
    this.tone('square', 420 + 300 * c, 90, 0.07 + 0.05 * c, 0.12, pan);
    this.noiseBurst('lowpass', 5000, 400, 0.7, 0.08 + 0.12 * c, 0.25 + 0.35 * c, pan);
    if (c > 0.9) this.tone('sawtooth', 1200, 300, 0.12, 0.06, pan); // full-power zing
  }

  hit(force: number, pan: number): void {
    const k = Math.min(1, force / 20);
    this.click(3000, 0.5, pan, 0.014);
    this.tone('square', 900, 220, 0.04, 0.12, pan); // snap
    this.tone('sine', 120, 32, 0.22 + 0.2 * k, 0.6 + 0.4 * k, pan);
    this.tone('triangle', 260, 70, 0.1, 0.25, pan);
    this.noiseBurst('lowpass', 1400, 200, 1, 0.12 + 0.1 * k, 0.35 + 0.3 * k, pan);
    if (k > 0.5) this.noiseBurst('bandpass', 2500, 800, 1.5, 0.18, 0.25 * k, pan); // crunch
  }

  bump(force: number, pan: number): void {
    const k = Math.min(1, force / 10);
    this.tone('sine', 200, 70, 0.1, 0.2 + 0.3 * k, pan);
    this.noiseBurst('bandpass', 900, 300, 2, 0.06, 0.15 + 0.15 * k, pan);
  }

  cancel(pan: number): void {
    this.click(6000, 0.25, pan, 0.008);
    this.tone('triangle', 1600, 700, 0.09, 0.22, pan);
    this.noiseBurst('highpass', 4000, 2000, 0.8, 0.06, 0.2, pan);
  }

  /** Silences every charge voice except the given ids. */
  silenceChargesExcept(ids: ReadonlySet<number>): void {
    for (const id of this.voices.keys()) if (!ids.has(id)) this.setCharge(id, 0, 0, 0);
  }

  shrinkTick(): void {
    this.tone('square', 1500, 1400, 0.03, 0.05);
  }

  whoosh(pan: number): void {
    this.noiseBurst('bandpass', 2600, 180, 3, 0.9, 0.5, pan, 0.08);
    this.tone('sine', 700, 60, 0.9, 0.18, pan);
  }

  countdown(n: number): void {
    if (n === 0) {
      this.fight();
      return;
    }
    this.click(5000, 0.12, 0, 0.008);
    this.tone('sine', 520, 520, 0.13, 0.3);
    this.tone('square', 1040, 1040, 0.05, 0.04);
  }

  /** Short jingle after a knockout. Happier when you won the round. */
  ko(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047] : [440, 392, 330];
    notes.forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.18, 0, 0.12 + i * 0.09));
  }

  /** Each power-up has its own little jingle. */
  pickup(kind: PowerupKind, pan: number): void {
    this.click(6000, 0.1, pan, 0.006);
    switch (kind) {
      case 'rapid':
        [880, 1100, 1320, 1760, 2200].forEach((f, i) => this.tone('square', f, f, 0.04, 0.07, pan, i * 0.03));
        break;
      case 'triple':
        [990, 990, 1320].forEach((f, i) => this.tone('square', f, f, 0.05, 0.09, pan, i * 0.07));
        break;
      case 'mega':
        this.tone('sawtooth', 110, 220, 0.35, 0.12, pan);
        [330, 440, 660].forEach((f, i) => this.tone('square', f, f, 0.2, 0.06, pan, 0.05 + i * 0.06));
        break;
      case 'shield':
        this.tone('sine', 700, 1400, 0.3, 0.15, pan);
        this.tone('triangle', 1050, 2100, 0.3, 0.08, pan, 0.04);
        break;
      case 'heal':
        [1047, 1319, 1568, 2093].forEach((f, i) => this.tone('sine', f, f, 0.12, 0.12, pan, i * 0.05));
        break;
    }
  }

  /** Little sparkle when a power-up appears. */
  powerupSpawn(pan: number): void {
    this.tone('sine', 1800, 2600, 0.12, 0.08, pan);
    this.tone('sine', 2400, 3200, 0.1, 0.06, pan, 0.06);
  }

  /** Metallic clang when a shield blocks a shot. */
  block(pan: number): void {
    this.tone('triangle', 900, 880, 0.25, 0.25, pan);
    this.tone('square', 1350, 1300, 0.15, 0.08, pan);
    this.noiseBurst('highpass', 3000, 1500, 1, 0.08, 0.2, pan);
  }

  /** Click as each map card passes the spinner's pointer; a ding when it lands. */
  carouselTick(final: boolean): void {
    if (final) {
      this.click(6000, 0.15, 0, 0.01);
      [784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f, 0.18, 0.14, 0, i * 0.06));
      return;
    }
    this.click(3500, 0.12, 0, 0.006);
    this.tone('square', 700, 650, 0.02, 0.04);
  }

  matchWin(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047, 784, 1047] : [392, 349, 330, 262];
    notes.forEach((f, i) => this.tone('square', f, f, 0.2, 0.08, 0, 0.1 + i * 0.12));
  }
}
