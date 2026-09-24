// Every sound is synthesized with WebAudio: soft oscillators, a generated
// noise buffer, and a small shared "room" reverb so everything sits in the
// same space. No audio files.
//
// The style aims for clean cartoon foley: guns are layered like real shots
// (a sharp crack, a noisy body, a low thump and a short room tail), UI sounds
// are soft plucks and woodblocks, and nothing uses harsh buzzy waveforms.

import type { PowerupKind } from '../shared/types.js';

const MUTE_KEY = 'recoil-muted';
const MASTER = 0.8;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Send into the room reverb. */
  private room: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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
      // Gentle glue compression, then out.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      comp.connect(ctx.destination);
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : MASTER;
      master.connect(comp);

      // One second of white noise, reused by every noisy sound.
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      // A short, dark room: decaying filtered noise as the impulse response.
      const len = Math.floor(ctx.sampleRate * 0.7);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          lp += (Math.random() * 2 - 1 - lp) * 0.35;
          d[i] = lp * Math.pow(1 - i / len, 3.2);
        }
      }
      const verb = ctx.createConvolver();
      verb.buffer = ir;
      const room = ctx.createGain();
      room.gain.value = 0.22;
      room.connect(verb).connect(master);

      this.ctx = ctx;
      this.master = master;
      this.room = room;
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
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  /** A panned output, with an optional amount sent to the room reverb. */
  private out(pan: number, wet = 0.3): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    if (this.room && wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      p.connect(send).connect(this.room);
    }
    return p;
  }

  /** A pitched blip: fast attack, exponential fall, pitch gliding from f0 to f1. */
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, pan = 0, delay = 0, wet = 0.3): void {
    const ctx = this.ctx;
    const dest = this.out(pan, wet);
    if (!ctx || !dest || vol <= 0) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** A soft plucked note: a sine with a quieter octave, like a marimba or a toy piano. */
  private pluck(freq: number, dur: number, vol: number, pan = 0, delay = 0): void {
    this.tone('sine', freq, freq, dur, vol, pan, delay, 0.35);
    this.tone('sine', freq * 2, freq * 2, dur * 0.45, vol * 0.3, pan, delay, 0.35);
    this.tone('triangle', freq * 4, freq * 4, dur * 0.12, vol * 0.12, pan, delay, 0.2);
  }

  /** Filtered noise with an attack and a decay; the filter sweeps from f0 to f1. */
  private noiseBurst(filter: BiquadFilterType, f0: number, f1: number, q: number, dur: number, vol: number, pan = 0, attack = 0.002, delay = 0, wet = 0.3): void {
    const ctx = this.ctx;
    const dest = this.out(pan, wet);
    if (!ctx || !dest || !this.noise || vol <= 0) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + attack + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + attack + dur + 0.05);
  }

  /** A couple of milliseconds of bright noise: the transient that makes a sound feel crisp. */
  private click(freq: number, vol: number, pan = 0, dur = 0.006, delay = 0): void {
    this.noiseBurst('highpass', freq, freq, 0.7, dur, vol, pan, 0.0005, delay, 0.1);
  }

  /** A springy boing for bumpers and pads. */
  private boing(f0: number, dur: number, vol: number, pan: number): void {
    const ctx = this.ctx;
    const dest = this.out(pan, 0.25);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0 * 0.7, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.6, t0 + dur * 0.2);
    osc.frequency.exponentialRampToValueAtTime(f0, t0 + dur);
    lfo.frequency.setValueAtTime(22, t0);
    lfo.frequency.linearRampToValueAtTime(9, t0 + dur);
    depth.gain.setValueAtTime(f0 * 0.18, t0);
    depth.gain.exponentialRampToValueAtTime(1, t0 + dur);
    lfo.connect(depth).connect(osc.frequency);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + dur + 0.05);
    lfo.stop(t0 + dur + 0.05);
  }

  /**
   * A gunshot, built from layers: a transient, a crack (the supersonic snap),
   * a noisy body, a low thump for weight, and a tail into the room.
   */
  private gunshot(o: { crack: number; body: number; thump: number; size: number; tail: number; vol: number; pan: number }): void {
    const { crack, body, thump, size, tail, vol, pan } = o;
    this.click(6000, 0.5 * vol, pan, 0.004);
    this.noiseBurst('bandpass', crack, crack * 0.7, 1.1, 0.035 + size * 0.02, 0.55 * vol, pan, 0.001, 0, 0.15);
    this.noiseBurst('lowpass', body, 250, 0.8, 0.07 + size * 0.09, 0.6 * vol, pan, 0.001, 0, 0.35);
    this.tone('sine', thump, thump * 0.35, 0.09 + size * 0.1, 0.55 * vol, pan, 0, 0.1);
    this.noiseBurst('lowpass', 1400, 300, 0.5, tail, 0.12 * vol, pan, 0.01, 0.02, 1);
  }

  /** The metallic "chk" of a gun's action. */
  private action(pan: number, vol: number, delay: number): void {
    this.noiseBurst('bandpass', 2400, 1800, 4, 0.025, 0.25 * vol, pan, 0.001, delay, 0.1);
    this.tone('triangle', 1250, 1150, 0.03, 0.05 * vol, pan, delay, 0.1);
  }

  // -------------------------------------------------------------------------
  // UI sounds
  // -------------------------------------------------------------------------

  /** Soft tick for buttons. */
  uiClick(): void {
    this.tone('sine', 1400, 1100, 0.035, 0.09, 0, 0, 0.1);
    this.click(5000, 0.05, 0, 0.003);
  }

  /** Bubbly pop for picking a colour or a card. */
  uiPop(): void {
    this.tone('sine', 480, 880, 0.08, 0.2, 0, 0, 0.15);
  }

  /** Two-note chime for confirming (create, join, start, copy link). */
  uiConfirm(): void {
    this.pluck(784, 0.18, 0.18);
    this.pluck(1175, 0.26, 0.16, 0, 0.07);
  }

  playerJoined(): void {
    this.pluck(659, 0.14, 0.1);
    this.pluck(988, 0.18, 0.1, 0, 0.07);
  }

  playerLeft(): void {
    this.pluck(659, 0.14, 0.09);
    this.pluck(494, 0.2, 0.09, 0, 0.07);
  }

  // -------------------------------------------------------------------------
  // Game sounds
  // -------------------------------------------------------------------------

  bumper(force: number, pan: number): void {
    const k = Math.min(1, force / 12);
    this.boing(240 + 100 * k, 0.34, 0.25 + 0.2 * k, pan);
    this.noiseBurst('lowpass', 900, 200, 0.7, 0.05, 0.15, pan);
  }

  /** A light hop: cloth rustle and a soft rising blip. */
  jump(pan: number, volume = 1): void {
    this.noiseBurst('bandpass', 700, 1500, 0.9, 0.08, 0.08 * volume, pan, 0.01, 0, 0.1);
    this.tone('sine', 300, 560, 0.08, 0.06 * volume, pan, 0, 0.1);
  }

  /** A shot from a specific weapon (0 Revolver, 1 Scatter, 2 Longshot, 3 Boomer, 4 Pepper). */
  shot(weapon: number, pan: number, volume = 1): void {
    switch (weapon) {
      case 1: // Scatter: a shotgun boom, then the pump.
        this.gunshot({ crack: 1700, body: 3200, thump: 95, size: 1, tail: 0.45, vol: 0.95 * volume, pan });
        this.action(pan, volume, 0.32);
        this.action(pan, volume * 0.8, 0.42);
        break;
      case 2: // Longshot: a big rifle crack with a long echo, then the bolt.
        this.gunshot({ crack: 3200, body: 5000, thump: 115, size: 1, tail: 0.9, vol: 1.05 * volume, pan });
        this.noiseBurst('highpass', 5000, 3000, 0.7, 0.6, 0.06 * volume, pan, 0.02, 0.06, 1);
        this.action(pan, volume * 0.8, 0.45);
        this.action(pan, volume * 0.7, 0.6);
        break;
      case 3: // Boomer: a hollow launcher "thoonk".
        this.tone('sine', 190, 70, 0.22, 0.6 * volume, pan, 0, 0.2);
        this.noiseBurst('lowpass', 1600, 180, 0.9, 0.16, 0.4 * volume, pan, 0.002, 0, 0.3);
        this.noiseBurst('bandpass', 420, 300, 3, 0.12, 0.2 * volume, pan, 0.002, 0.01, 0.2);
        this.action(pan, volume * 0.7, 0.18);
        break;
      case 4: // Pepper: a tight little SMG pop.
        this.gunshot({ crack: 2600, body: 3800, thump: 150, size: 0.15, tail: 0.12, vol: 0.45 * volume, pan });
        break;
      default: // Revolver: a punchy handgun shot and the cylinder turning.
        this.gunshot({ crack: 2400, body: 4200, thump: 110, size: 0.6, tail: 0.4, vol: 0.85 * volume, pan });
        this.action(pan, volume * 0.5, 0.12);
    }
  }

  /** A bomb bursting. */
  boom(size: number, pan: number): void {
    const k = Math.min(1, size / 4);
    this.click(3000, 0.3, pan, 0.006);
    this.noiseBurst('lowpass', 3000, 90, 0.7, 0.6 + 0.2 * k, 0.6, pan, 0.002, 0, 0.6);
    this.tone('sine', 110, 32, 0.5, 0.65, pan, 0, 0.2);
    this.noiseBurst('bandpass', 700, 200, 1.5, 0.3, 0.2, pan, 0.01, 0.03, 0.8);
  }

  /** Pulling the knife out: a bright metallic "shing". */
  knifeDraw(pan = 0, volume = 1): void {
    this.noiseBurst('highpass', 6000, 9000, 0.7, 0.18, 0.1 * volume, pan, 0.03, 0, 0.3);
    for (const [f, v] of [
      [2800, 0.05],
      [4190, 0.035],
      [5610, 0.025],
    ] as const) {
      this.tone('sine', f, f * 1.01, 0.35, v * volume, pan, 0.02, 0.5);
    }
  }

  /** Putting the gun back up. */
  gunDraw(pan = 0, volume = 1): void {
    this.action(pan, volume, 0);
    this.action(pan, volume * 0.7, 0.07);
  }

  /** Knife: a quick swish through the air, with a meaty thwack if it connects. */
  knife(hit: boolean, pan: number, volume = 1): void {
    this.noiseBurst('bandpass', 1200, 4800, 1.6, 0.11, 0.28 * volume, pan, 0.02, 0, 0.1);
    if (hit) {
      this.noiseBurst('bandpass', 1800, 700, 1.2, 0.06, 0.45 * volume, pan, 0.001, 0.03, 0.2);
      this.tone('sine', 170, 55, 0.16, 0.6 * volume, pan, 0.03, 0.15);
    }
  }

  /** Grenade tossed: a whoosh and a pin ping. */
  throwGrenade(pan: number, volume = 1): void {
    this.tone('sine', 2600, 2550, 0.12, 0.06 * volume, pan, 0, 0.3);
    this.noiseBurst('bandpass', 900, 2200, 1.2, 0.16, 0.18 * volume, pan, 0.03, 0.02, 0.2);
  }

  /** Shockwave: a deep thump and a quick bright ring. */
  shockwave(pan: number): void {
    this.tone('sine', 95, 30, 0.5, 0.65, pan, 0, 0.2);
    this.noiseBurst('lowpass', 1200, 80, 0.8, 0.45, 0.45, pan, 0.002, 0, 0.6);
    this.tone('sine', 700, 1800, 0.25, 0.07, pan, 0, 0.6);
    this.tone('sine', 1050, 2700, 0.22, 0.04, pan, 0.02, 0.6);
  }

  /** Jump pad: a springy whoomp. */
  pad(pan: number): void {
    this.boing(170, 0.42, 0.3, pan);
    this.noiseBurst('lowpass', 800, 3000, 0.7, 0.25, 0.12, pan, 0.02, 0, 0.3);
  }

  /** Sliding: a scrape across the roof. */
  slide(pan: number, volume = 1): void {
    this.noiseBurst('bandpass', 1500, 600, 0.8, 0.38, 0.16 * volume, pan, 0.02, 0, 0.15);
  }

  /** Pulling yourself up a ledge: a grab and a shuffle. */
  mantle(pan: number, volume = 1): void {
    this.noiseBurst('lowpass', 1200, 300, 0.8, 0.06, 0.18 * volume, pan, 0.002, 0, 0.1);
    this.noiseBurst('bandpass', 900, 1400, 1, 0.1, 0.1 * volume, pan, 0.01, 0.06, 0.1);
  }

  /** Soft thump when you land. */
  land(force: number): void {
    const k = Math.min(1, force / 20);
    this.tone('sine', 130, 55, 0.1, 0.12 + 0.25 * k, 0, 0, 0.05);
    this.noiseBurst('lowpass', 800, 200, 0.7, 0.07, 0.05 + 0.12 * k, 0, 0.002, 0, 0.05);
  }

  /** Recoil mode switched on or off: a latch clack, higher when turning on. */
  recoilToggle(on: boolean): void {
    this.action(0, 1, 0);
    this.pluck(on ? 988 : 587, 0.14, 0.1, 0, 0.03);
  }

  respawn(pan: number): void {
    this.pluck(523, 0.12, 0.08, pan);
    this.pluck(784, 0.18, 0.08, pan, 0.06);
  }

  /** Stinger on "FIGHT!": a soft cymbal swell and a bright chord. */
  fight(): void {
    this.noiseBurst('highpass', 5000, 7000, 0.7, 0.6, 0.12, 0, 0.004, 0, 0.8);
    for (const f of [523, 659, 784, 1047]) this.pluck(f, 0.4, 0.07);
    this.tone('sine', 110, 55, 0.3, 0.4, 0, 0, 0.1);
  }

  /** Your shot landed: a crisp tick, meatier for a heavy hit. */
  hitmarker(heavy: boolean): void {
    this.tone('sine', heavy ? 1500 : 1900, heavy ? 1300 : 1800, 0.05, heavy ? 0.16 : 0.1, 0, 0, 0.05);
    this.click(6000, heavy ? 0.2 : 0.12, 0, 0.003);
  }

  /** Someone you hit went off the roof: a bright two-note confirm. */
  knockoutConfirm(): void {
    this.pluck(1175, 0.12, 0.16);
    this.pluck(1760, 0.2, 0.14, 0, 0.06);
  }

  /** A footstep on the roof: a soft scuff, a little heavier when sprinting. */
  step(sprinting: boolean): void {
    const v = sprinting ? 1 : 0.7;
    this.noiseBurst('lowpass', 1100 + Math.random() * 300, 250, 0.8, 0.05, 0.07 * v, (Math.random() - 0.5) * 0.2, 0.002, 0, 0.05);
    this.tone('sine', 110 + Math.random() * 20, 60, 0.05, 0.05 * v, 0, 0, 0.02);
  }

  /** Getting hit: a cartoon thwack, heavier the harder the hit. */
  hit(force: number, pan: number): void {
    const k = Math.min(1, force / 25);
    this.click(3500, 0.35, pan, 0.004);
    this.noiseBurst('bandpass', 1400, 600, 1.1, 0.07, 0.5, pan, 0.001, 0, 0.2);
    this.tone('sine', 190, 60, 0.14 + 0.16 * k, 0.55 + 0.3 * k, pan, 0, 0.15);
    if (k > 0.5) this.noiseBurst('lowpass', 900, 120, 0.8, 0.3, 0.35 * k, pan, 0.002, 0.01, 0.5);
  }

  bump(force: number, pan: number): void {
    const k = Math.min(1, force / 10);
    this.tone('sine', 190, 75, 0.1, 0.2 + 0.25 * k, pan, 0, 0.1);
    this.noiseBurst('lowpass', 900, 250, 0.8, 0.06, 0.12 + 0.12 * k, pan);
  }

  /** Two shots cancelling out, or a shot hitting the roof: a ricochet. */
  cancel(pan: number): void {
    this.click(5000, 0.15, pan, 0.004);
    this.tone('sine', 2400, 1300, 0.14, 0.06, pan, 0, 0.5);
    this.noiseBurst('bandpass', 2500, 1200, 2, 0.05, 0.1, pan);
  }

  /** A soft tick while the roof shrinks. */
  shrinkTick(): void {
    this.tone('sine', 1500, 1450, 0.04, 0.04, 0, 0, 0.1);
  }

  /** Falling off: a long descending whistle and rushing air. */
  whoosh(pan: number): void {
    this.noiseBurst('bandpass', 2200, 250, 2, 0.9, 0.35, pan, 0.08, 0, 0.3);
    this.tone('sine', 1200, 300, 0.9, 0.08, pan, 0, 0.3);
  }

  /** Countdown woodblock ticks, then the FIGHT stinger. */
  countdown(n: number): void {
    if (n === 0) {
      this.fight();
      return;
    }
    this.tone('sine', 880, 820, 0.08, 0.28, 0, 0, 0.2);
    this.noiseBurst('bandpass', 1800, 1500, 5, 0.03, 0.15, 0, 0.001, 0, 0.1);
  }

  /** Short jingle after a knockout. Happier when you won the round. */
  ko(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047] : [440, 392, 330];
    notes.forEach((f, i) => this.pluck(f, 0.22, 0.16, 0, 0.1 + i * 0.09));
  }

  /** Each power-up has its own little jingle. */
  pickup(kind: PowerupKind, pan: number): void {
    switch (kind) {
      case 'rapid':
        [880, 1109, 1319, 1760].forEach((f, i) => this.pluck(f, 0.1, 0.09, pan, i * 0.035));
        break;
      case 'triple':
        [988, 988, 1319].forEach((f, i) => this.pluck(f, 0.12, 0.1, pan, i * 0.07));
        break;
      case 'mega':
        this.tone('sine', 110, 220, 0.35, 0.18, pan, 0, 0.3);
        [330, 440, 659].forEach((f, i) => this.pluck(f, 0.25, 0.1, pan, 0.05 + i * 0.06));
        break;
      case 'shield':
        this.tone('sine', 700, 1400, 0.3, 0.12, pan, 0, 0.5);
        this.tone('sine', 1050, 2100, 0.3, 0.06, pan, 0.04, 0.5);
        break;
      case 'heal':
        [1047, 1319, 1568, 2093].forEach((f, i) => this.pluck(f, 0.16, 0.09, pan, i * 0.05));
        break;
    }
  }

  /** Little sparkle when a power-up appears. */
  powerupSpawn(pan: number): void {
    this.pluck(1760, 0.12, 0.05, pan);
    this.pluck(2349, 0.14, 0.04, pan, 0.06);
  }

  /** A ringing clang when a shield blocks a shot. */
  block(pan: number): void {
    this.click(4000, 0.2, pan, 0.004);
    for (const [f, v] of [
      [880, 0.16],
      [1391, 0.08],
      [2127, 0.05],
    ] as const) {
      this.tone('sine', f, f * 0.99, 0.4, v, pan, 0, 0.4);
    }
  }

  matchWin(good: boolean): void {
    const notes = good ? [523, 659, 784, 1047, 784, 1047] : [392, 349, 330, 262];
    notes.forEach((f, i) => this.pluck(f, 0.3, 0.12, 0, 0.1 + i * 0.12));
  }
}
