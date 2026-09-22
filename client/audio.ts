// Every sound is synthesized with WebAudio: oscillators plus a generated
// noise buffer. No audio files.

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

  // -------------------------------------------------------------------------
  // Game sounds
  // -------------------------------------------------------------------------

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
    this.tone('sine', 160 + 60 * c, 40, 0.14 + 0.1 * c, 0.5 + 0.4 * c, pan);
    this.tone('square', 420 + 300 * c, 90, 0.07 + 0.05 * c, 0.12, pan);
    this.noiseBurst('lowpass', 5000, 400, 0.7, 0.08 + 0.12 * c, 0.25 + 0.35 * c, pan);
  }

  hit(force: number, pan: number): void {
    const k = Math.min(1, force / 20);
    this.tone('sine', 120, 32, 0.22 + 0.2 * k, 0.6 + 0.4 * k, pan);
    this.tone('triangle', 260, 70, 0.1, 0.25, pan);
    this.noiseBurst('lowpass', 1400, 200, 1, 0.12 + 0.1 * k, 0.35 + 0.3 * k, pan);
  }

  bump(force: number, pan: number): void {
    const k = Math.min(1, force / 10);
    this.tone('sine', 200, 70, 0.1, 0.2 + 0.3 * k, pan);
    this.noiseBurst('bandpass', 900, 300, 2, 0.06, 0.15 + 0.15 * k, pan);
  }

  cancel(pan: number): void {
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
    this.tone('sine', n > 0 ? 520 : 1040, n > 0 ? 520 : 1040, n > 0 ? 0.13 : 0.35, 0.3);
    if (n === 0) this.tone('square', 780, 780, 0.3, 0.08);
  }

  /** Short jingle after a knockout. Happier when you won the round. */
  ko(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047] : [440, 392, 330];
    notes.forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.18, 0, 0.12 + i * 0.09));
  }

  /** Bright rising arpeggio when you grab a power-up. */
  pickup(pan: number): void {
    [660, 880, 1320].forEach((f, i) => this.tone('square', f, f * 1.02, 0.08, 0.1, pan, i * 0.05));
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

  /** Click as each map card passes in the carousel. */
  carouselTick(final: boolean): void {
    this.tone('square', final ? 1100 : 700, final ? 1100 : 650, final ? 0.12 : 0.025, final ? 0.12 : 0.05);
  }

  matchWin(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047, 784, 1047] : [392, 349, 330, 262];
    notes.forEach((f, i) => this.tone('square', f, f, 0.2, 0.08, 0, 0.1 + i * 0.12));
  }
}
