// Voice chat: peer-to-peer WebRTC audio between the players in a room. The
// game server only relays the signalling (offers, answers, ICE candidates);
// the audio itself goes straight between browsers.
//
// - Modes: off, push-to-talk (hold V) and open mic. The choice is remembered.
// - Everyone is heard from where they stand on the roof (3D panning).
// - Players can be muted one by one, and whoever is talking is flagged.
//
// Each pair of players has one connection; the lower seat number makes the
// offer, so both sides never offer at once.

import type { ClientMessage, PlayerId, RosterEntry, RtcSignal } from '../shared/types.js';

export type VoiceMode = 'off' | 'ptt' | 'open';

const MODE_KEY = 'recoil-voice';
const VOLUME_KEY = 'recoil-voice-volume';
const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
/** Loudness (RMS, 0..1) above which a player counts as talking. */
const SPEAK_LEVEL = 0.025;

interface Peer {
  pc: RTCPeerConnection;
  initiator: boolean;
  /** ICE candidates that arrived before the remote description. */
  pending: RTCIceCandidateInit[];
  audio: HTMLAudioElement | null;
  panner: PannerNode | null;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  level: Uint8Array<ArrayBuffer> | null;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class Voice {
  /** Called when the mode, mutes or who is talking changes (to refresh the UI). */
  onChange: () => void = () => {};

  private modeValue: VoiceMode = 'off';
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  /** Everyone's voices pass through here: the voice volume, then a limiter so loud doesn't crackle. */
  private bus: GainNode | null = null;
  /** The voice volume slider: 1 = as sent, up to 4× louder. */
  private volumeValue = 2.5;
  private readonly peers = new Map<PlayerId, Peer>();
  private readonly mutedIds = new Set<PlayerId>();
  private myId: PlayerId | -1 = -1;
  private roster: RosterEntry[] = [];
  private pushing = false;
  private lastSpeaking = '';
  private speakingIds = new Set<PlayerId>();

  constructor(private readonly send: (msg: ClientMessage) => void) {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === 'ptt' || saved === 'open') this.modeValue = saved;
      const vol = Number(localStorage.getItem(VOLUME_KEY));
      if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(vol)) this.volumeValue = Math.max(0, Math.min(4, vol));
    } catch {
      // Storage unavailable: start with voice off.
    }
    const typing = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyV' || e.repeat || typing(e.target)) return;
      this.setPushing(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyV') this.setPushing(false);
    });
    window.addEventListener('blur', () => this.setPushing(false));
  }

  /** The mode picked last time; the mic is only opened after joining a room. */
  get mode(): VoiceMode {
    return this.modeValue;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** True while your voice is going out. */
  get transmitting(): boolean {
    return this.active && (this.modeValue === 'open' || this.pushing);
  }

  get muted(): ReadonlySet<PlayerId> {
    return this.mutedIds;
  }

  get speaking(): ReadonlySet<PlayerId> {
    return this.speakingIds;
  }

  /** Cycles off -> push-to-talk -> open mic -> off. Returns an error to show, if any. */
  async cycleMode(): Promise<string | null> {
    const next: VoiceMode = this.modeValue === 'off' ? 'ptt' : this.modeValue === 'ptt' ? 'open' : 'off';
    return this.setMode(next);
  }

  async setMode(mode: VoiceMode): Promise<string | null> {
    this.modeValue = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Not remembered, but it still works this session.
    }
    let error: string | null = null;
    if (mode === 'off') this.stop();
    else if (this.myId !== -1) error = await this.start();
    this.applyTrack();
    this.onChange();
    return error;
  }

  /** Joined a room (or left one, with -1). Reopens the mic if voice was on. */
  async setSeat(myId: PlayerId | -1): Promise<string | null> {
    if (myId === this.myId) return null;
    this.closeAll();
    this.myId = myId;
    if (myId === -1) {
      this.stop();
      return null;
    }
    const error = this.modeValue !== 'off' ? await this.start() : null;
    this.onChange();
    return error;
  }

  /** How loud other players' voices are (0..4, 1 = as sent). */
  get volume(): number {
    return this.volumeValue;
  }

  /** Sets how loud other players' voices are, remembered between visits. */
  setVolume(v: number): void {
    this.volumeValue = Math.max(0, Math.min(4, v));
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volumeValue));
    } catch {
      // Not remembered, but it still works this session.
    }
    if (this.ctx && this.bus) this.bus.gain.setTargetAtTime(this.volumeValue, this.ctx.currentTime, 0.02);
    for (const peer of this.peers.values()) if (peer.audio && !peer.gain) peer.audio.volume = Math.min(1, this.volumeValue);
  }

  toggleMute(id: PlayerId): void {
    if (this.mutedIds.has(id)) this.mutedIds.delete(id);
    else this.mutedIds.add(id);
    const peer = this.peers.get(id);
    if (peer?.gain) peer.gain.gain.value = this.mutedIds.has(id) ? 0 : 1;
    this.onChange();
  }

  private setPushing(on: boolean): void {
    if (this.pushing === on) return;
    this.pushing = on;
    this.applyTrack();
    this.onChange();
  }

  private applyTrack(): void {
    const on = this.transmitting;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = on;
  }

  // -------------------------------------------------------------------------
  // Mic
  // -------------------------------------------------------------------------

  private async start(): Promise<string | null> {
    if (this.stream) return null;
    if (!navigator.mediaDevices?.getUserMedia) return 'Voice chat needs a secure (https) page.';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.modeValue = 'off';
      try {
        localStorage.setItem(MODE_KEY, 'off');
      } catch {
        // Not remembered.
      }
      this.onChange();
      return 'Microphone blocked. Allow it in the address bar to use voice chat.';
    }
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    this.ctx ??= Ctx ? new Ctx() : null;
    if (this.ctx && !this.bus) {
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.bus = this.ctx.createGain();
      this.bus.gain.value = this.volumeValue;
      this.bus.connect(limiter).connect(this.ctx.destination);
    }
    void this.ctx?.resume();
    this.applyTrack();
    this.send({ t: 'voice', on: true });
    this.sync(this.roster);
    return null;
  }

  private stop(): void {
    this.closeAll();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.stream) this.send({ t: 'voice', on: false });
    this.stream = null;
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  /** Connects to everyone in the room who has voice on, and drops anyone who left or switched it off. */
  sync(roster: RosterEntry[]): void {
    this.roster = roster;
    const want = new Set<PlayerId>();
    if (this.active && this.myId !== -1) {
      for (const r of roster) if (r.voice && r.online && r.id !== this.myId) want.add(r.id);
    }
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.close(id);
    for (const id of want) {
      if (this.peers.has(id)) continue;
      const peer = this.open(id, this.myId < id);
      if (peer.initiator) void this.offer(id, peer);
    }
  }

  private open(id: PlayerId, initiator: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: Peer = { pc, initiator, pending: [], audio: null, panner: null, gain: null, analyser: null, level: null };
    this.peers.set(id, peer);
    for (const track of this.stream?.getAudioTracks() ?? []) pc.addTrack(track, this.stream as MediaStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: 'rtc', to: id, d: { ice: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } } });
    };
    pc.ontrack = (e) => this.attach(peer, e.streams[0] ?? new MediaStream([e.track]), id);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Try once more from scratch on the next roster sync.
        this.close(id);
        this.sync(this.roster);
      }
    };
    return peer;
  }

  private async offer(id: PlayerId, peer: Peer): Promise<void> {
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      const d = peer.pc.localDescription;
      if (d) this.send({ t: 'rtc', to: id, d: { sdp: { type: 'offer', sdp: d.sdp } } });
    } catch (err) {
      console.warn('[recoil] voice offer failed', err);
    }
  }

  /** A signalling message from another player. */
  async handleSignal(from: PlayerId, d: RtcSignal): Promise<void> {
    if (!this.active || from === this.myId) return;
    let peer = this.peers.get(from);
    try {
      if ('sdp' in d) {
        if (d.sdp.type === 'offer') {
          // They offered, so we answer (replacing any stale connection).
          if (peer?.initiator) return;
          if (peer) this.close(from);
          peer = this.open(from, false);
          await peer.pc.setRemoteDescription(d.sdp);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          const local = peer.pc.localDescription;
          if (local) this.send({ t: 'rtc', to: from, d: { sdp: { type: 'answer', sdp: local.sdp } } });
        } else if (peer?.initiator) {
          await peer.pc.setRemoteDescription(d.sdp);
        }
        if (peer) for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c);
      } else if (peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(d.ice);
        else peer.pending.push(d.ice);
      }
    } catch (err) {
      console.warn('[recoil] voice signalling failed', err);
    }
  }

  /** Routes a player's voice through a 3D panner so they sound like they're where they stand. */
  private attach(peer: Peer, stream: MediaStream, id: PlayerId): void {
    // Chrome only lets WebRTC audio flow into Web Audio if an element is also playing it (muted).
    const audio = new Audio();
    audio.muted = true;
    audio.srcObject = stream;
    void audio.play().catch(() => {});
    peer.audio = audio;
    const ctx = this.ctx;
    if (!ctx || !this.bus) {
      audio.muted = false;
      audio.volume = Math.min(1, this.volumeValue);
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    // Fades a little with distance, but you can still hear someone across the map.
    panner.refDistance = 12;
    panner.rolloffFactor = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = this.mutedIds.has(id) ? 0 : 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    source.connect(panner).connect(gain).connect(this.bus);
    peer.panner = panner;
    peer.gain = gain;
    peer.analyser = analyser;
    peer.level = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }

  private close(id: PlayerId): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.close();
    peer.gain?.disconnect();
    peer.panner?.disconnect();
    if (peer.audio) peer.audio.srcObject = null;
  }

  private closeAll(): void {
    for (const id of [...this.peers.keys()]) this.close(id);
  }

  // -------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------

  /**
   * Moves the listener to the camera and each voice to its player (positions
   * in three.js coordinates), and works out who is talking.
   */
  update(listener: { pos: Vec3; forward: Vec3; up: Vec3 }, heads: ReadonlyMap<PlayerId, Vec3>): void {
    const ctx = this.ctx;
    if (ctx && this.peers.size > 0) {
      const l = ctx.listener;
      const t = ctx.currentTime;
      if (l.positionX) {
        l.positionX.setValueAtTime(listener.pos.x, t);
        l.positionY.setValueAtTime(listener.pos.y, t);
        l.positionZ.setValueAtTime(listener.pos.z, t);
        l.forwardX.setValueAtTime(listener.forward.x, t);
        l.forwardY.setValueAtTime(listener.forward.y, t);
        l.forwardZ.setValueAtTime(listener.forward.z, t);
        l.upX.setValueAtTime(listener.up.x, t);
        l.upY.setValueAtTime(listener.up.y, t);
        l.upZ.setValueAtTime(listener.up.z, t);
      } else {
        l.setPosition(listener.pos.x, listener.pos.y, listener.pos.z);
        l.setOrientation(listener.forward.x, listener.forward.y, listener.forward.z, listener.up.x, listener.up.y, listener.up.z);
      }
      for (const [id, peer] of this.peers) {
        // Players not on the roof (watching, fallen) are heard from next to you.
        const head = heads.get(id) ?? listener.pos;
        const p = peer.panner;
        if (!p) continue;
        if (p.positionX) {
          p.positionX.setValueAtTime(head.x, t);
          p.positionY.setValueAtTime(head.y, t);
          p.positionZ.setValueAtTime(head.z, t);
        } else {
          p.setPosition(head.x, head.y, head.z);
        }
      }
    }

    const speaking = new Set<PlayerId>();
    for (const [id, peer] of this.peers) {
      if (!peer.analyser || !peer.level || this.mutedIds.has(id)) continue;
      peer.analyser.getByteTimeDomainData(peer.level);
      let sum = 0;
      for (const v of peer.level) sum += ((v - 128) / 128) ** 2;
      if (Math.sqrt(sum / peer.level.length) > SPEAK_LEVEL) speaking.add(id);
    }
    if (this.transmitting && this.myId !== -1) speaking.add(this.myId);
    const key = [...speaking].sort().join(',');
    this.speakingIds = speaking;
    if (key !== this.lastSpeaking) {
      this.lastSpeaking = key;
      this.onChange();
    }
  }
}
