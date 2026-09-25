// RECOIL server: serves the built client over HTTP, hosts rooms of up to
// MAX_PLAYERS over WebSocket at /ws, and runs every room's simulation at a
// fixed 30Hz.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as C from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { BOT_LEVEL_NAMES, BotBrain, isBotLevel, type BotLevel } from '../shared/bot.js';
import { NO_INPUT, addPlayer, createGame, enterLobby, getPlayer, playerSnap, removePlayer, setMapChoice, setOffhand, setCtf, setTeam, setTeams, setWeapon, startMatch, step } from '../shared/sim.js';
import { OFFHANDS, WEAPONS, isOffhand, isWeapon } from '../shared/weapons.js';
import {
  POWERUP_KINDS,
  ROOM_CODE_PATTERN,
  type BulletSnap,
  type ClientMessage,
  type GameState,
  type InputState,
  type PlayerId,
  type PowerupSnap,
  type RosterEntry,
  type RtcSignal,
  type ServerMessage,
  type Snapshot,
} from '../shared/types.js';

const PORT = Number(process.env.PORT ?? 3000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Built layout: dist/server/server/index.js serves dist/client.
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? path.join(HERE, '../../client'));

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

interface Client {
  ws: WebSocket;
  /** Random id the browser keeps per tab, used to reclaim a seat after a drop. */
  id: string;
  room: Room | null;
  seat: PlayerId | -1;
  lastSeen: number;
}

interface Seat {
  clientId: string;
  client: Client | null;
  name: string;
  color: number;
  weapon: number;
  offhand: number;
  voice: boolean;
  /** Set for a bot seat (no client, never disconnects). */
  bot: BotBrain | null;
  /** Inputs received but not yet simulated, one per tick, oldest first. */
  inputs: { seq: number; input: InputState }[];
  /** The last input simulated, repeated when the queue runs dry. */
  lastInput: InputState;
  lastSeq: number;
  disconnectedAt: number;
  /** Join order; the earliest connected player is the host. */
  joinedAt: number;
}

interface Room {
  code: string;
  state: GameState;
  seats: (Seat | null)[];
  spectators: Set<Client>;
  emptySince: number | null;
  lastRoster: string;
  /** Public (quick play) room: no host, starts itself, random map with the spinner. */
  pub: boolean;
  /** Public rooms: when the match starts automatically (ms), or null. */
  autoStartAt: number | null;
  /** Public rooms: when the next bot joins to fill the room (ms), or null. */
  botFillAt: number | null;
}

const rooms = new Map<string, Room>();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L or O: easy to read aloud
let joinCounter = 0;

function newRoomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function createRoom(pub: boolean): Room {
  const room: Room = {
    code: newRoomCode(),
    state: createGame(Math.floor(Math.random() * 0xffffffff)),
    seats: new Array<Seat | null>(C.MAX_PLAYERS).fill(null),
    spectators: new Set(),
    emptySince: null,
    lastRoster: '',
    pub,
    autoStartAt: null,
    botFillAt: null,
  };
  rooms.set(room.code, room);
  log(`${pub ? 'public' : 'private'} room ${room.code} created (${rooms.size} total)`);
  return room;
}

function roomClients(room: Room): Client[] {
  const out: Client[] = [...room.spectators];
  for (const s of room.seats) if (s?.client) out.push(s.client);
  return out;
}

function seatsUsed(room: Room): number {
  return room.seats.filter((s) => s !== null).length;
}

/** Quick play: the fullest public room still in its lobby, then one mid-match with space, else a new one. */
function findPublicRoom(): Room {
  const open = [...rooms.values()].filter((r) => r.pub && seatsUsed(r) < C.MAX_PLAYERS);
  const byFullest = (a: Room, b: Room): number => seatsUsed(b) - seatsUsed(a);
  const waiting = open.filter((r) => r.state.phase === 'lobby').sort(byFullest);
  const playing = open.filter((r) => r.state.phase !== 'lobby').sort(byFullest);
  return waiting[0] ?? playing[0] ?? createRoom(true);
}

function startRoomMatch(room: Room): void {
  // Anyone still reconnecting from last match loses their seat now.
  room.seats.forEach((s, id) => {
    if (s && !s.client && !s.bot) freeSeat(room, id);
  });
  room.autoStartAt = null;
  startMatch(room.state);
  log(`room ${room.code}: match started with ${seatsUsed(room)} players`);
}

/** The host of a private room: the earliest-joined connected player. Public rooms have none. */
function hostId(room: Room): PlayerId | -1 {
  if (room.pub) return -1;
  let best: PlayerId | -1 = -1;
  room.seats.forEach((s, id) => {
    if (s?.client && (best === -1 || s.joinedAt < (room.seats[best]?.joinedAt ?? Infinity))) best = id;
  });
  return best;
}

function colorTaken(room: Room, color: number, except: PlayerId | -1): boolean {
  return room.seats.some((s, id) => s !== null && id !== except && s.color === color);
}

function freeColor(room: Room, wanted: number, except: PlayerId | -1): number {
  if (!colorTaken(room, wanted, except)) return wanted;
  for (let c = 0; c < C.PLAYER_PALETTE.length; c++) if (!colorTaken(room, c, except)) return c;
  return wanted;
}

function cleanName(name: string, id: PlayerId): string {
  // Printable characters only, trimmed and length-limited.
  const clean = name.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, C.NAME_MAX);
  return clean || `Player ${id + 1}`;
}

function joinRoom(client: Client, room: Room, name: string, color: number, weapon: number): void {
  leaveRoom(client);
  const { seats } = room;

  // Prefer your own old seat (same browser tab), then any empty seat, then a bot's.
  let seat: PlayerId | -1 = seats.findIndex((s) => s !== null && s.clientId === client.id);
  if (seat === -1) seat = seats.findIndex((s) => s === null);
  if (seat === -1) {
    const bot = seats.findIndex((s) => s?.bot);
    if (bot !== -1) {
      freeSeat(room, bot);
      seat = bot;
    }
  }

  client.room = room;
  client.seat = seat;
  if (seat === -1) {
    room.spectators.add(client);
  } else {
    const prev = seats[seat];
    // Same tab reconnecting before we noticed its old socket died: take over.
    if (prev?.client && prev.client !== client) {
      prev.client.room = null;
      prev.client.seat = -1;
      prev.client.ws.close();
    }
    seats[seat] = {
      clientId: client.id,
      client,
      name: cleanName(name, seat),
      color: freeColor(room, color, seat),
      weapon,
      offhand: prev?.offhand ?? C.OFFHAND_KNIFE,
      voice: false,
      bot: null,
      inputs: [],
      lastInput: { ...NO_INPUT },
      lastSeq: 0,
      disconnectedAt: 0,
      joinedAt: prev?.joinedAt ?? joinCounter++,
    };
    addPlayer(room.state, seat, weapon);
    setOffhand(room.state, seat, seats[seat]?.offhand ?? C.OFFHAND_KNIFE);
    setWeapon(room.state, seat, weapon);
  }
  send(client, { t: 'joined', code: room.code, you: seat });
  room.lastRoster = ''; // force a roster update
  log(`room ${room.code}: ${seat === -1 ? 'spectator' : `seat ${seat + 1}`} joined`);
}

const BOT_NAMES = ['Rivet', 'Sprocket', 'Gizmo', 'Widget', 'Piston', 'Dynamo', 'Ratchet', 'Servo', 'Gasket', 'Flywheel'];

/** Seats a bot of the given difficulty, if there's room. Returns its seat, or -1. */
function addBot(room: Room, level: BotLevel): PlayerId | -1 {
  const seat = room.seats.findIndex((s) => s === null);
  if (seat === -1) return -1;
  const used = new Set(room.seats.map((s) => s?.name));
  const base = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${seat + 1}`;
  const weapon = Math.floor(Math.random() * WEAPONS.length);
  const offhand = Math.floor(Math.random() * OFFHANDS.length);
  room.seats[seat] = {
    clientId: `bot-${seat}-${joinCounter}`,
    client: null,
    name: base,
    color: freeColor(room, Math.floor(Math.random() * C.PLAYER_PALETTE.length), seat),
    weapon,
    offhand,
    voice: false,
    bot: new BotBrain(level),
    inputs: [],
    lastInput: { ...NO_INPUT },
    lastSeq: 0,
    disconnectedAt: 0,
    joinedAt: joinCounter++,
  };
  addPlayer(room.state, seat, weapon);
  setOffhand(room.state, seat, offhand);
  room.lastRoster = '';
  log(`room ${room.code}: ${BOT_LEVEL_NAMES[level].toLowerCase()} bot joined seat ${seat + 1}`);
  return seat;
}

function freeSeat(room: Room, id: PlayerId): void {
  room.seats[id] = null;
  removePlayer(room.state, id);
}

function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  if (client.seat === -1) {
    room.spectators.delete(client);
  } else {
    const seat = room.seats[client.seat];
    if (seat && seat.client === client) {
      if (room.state.phase === 'lobby') {
        // No match running, so just free the seat.
        freeSeat(room, client.seat);
      } else {
        // Keep the seat (and score) for a while so they can rejoin.
        seat.client = null;
        seat.inputs = [];
        seat.lastInput = { ...NO_INPUT, yaw: seat.lastInput.yaw, pitch: seat.lastInput.pitch };
        seat.disconnectedAt = Date.now();
      }
    }
  }
  client.room = null;
  client.seat = -1;
}

function handleMessage(client: Client, msg: ClientMessage): void {
  switch (msg.t) {
    case 'create':
      client.id = msg.id;
      joinRoom(client, createRoom(false), msg.name, msg.color, msg.w);
      break;
    case 'quick':
      client.id = msg.id;
      joinRoom(client, findPublicRoom(), msg.name, msg.color, msg.w);
      break;
    case 'map': {
      const room = client.room;
      if (room && !room.pub && room.state.phase === 'lobby' && hostId(room) === client.seat) setMapChoice(room.state, msg.choice);
      break;
    }
    case 'rules': {
      // The host of a private room can switch the rules (no jumping, teams) between matches.
      const room = client.room;
      if (room && !room.pub && room.state.phase === 'lobby' && hostId(room) === client.seat) {
        room.state.noJump = msg.noJump;
        setTeams(room.state, msg.teams || msg.ctf);
        setCtf(room.state, msg.ctf);
      }
      break;
    }
    case 'team': {
      const room = client.room;
      if (room && client.seat !== -1 && room.seats[client.seat]?.client === client) setTeam(room.state, client.seat, msg.team);
      break;
    }
    case 'join': {
      client.id = msg.id;
      const room = rooms.get(msg.code);
      if (room) joinRoom(client, room, msg.name, msg.color, msg.w);
      else send(client, { t: 'error', msg: `Room ${msg.code} not found. It may have expired.` });
      break;
    }
    case 'profile': {
      const room = client.room;
      const seat = room && client.seat !== -1 ? room.seats[client.seat] : null;
      if (!room || !seat || seat.client !== client) break;
      seat.name = cleanName(msg.name, client.seat);
      if (!colorTaken(room, msg.color, client.seat)) seat.color = msg.color;
      break;
    }
    case 'offhand': {
      const room = client.room;
      const seat = room && client.seat !== -1 ? room.seats[client.seat] : null;
      if (!room || !seat || seat.client !== client) break;
      seat.offhand = msg.o;
      setOffhand(room.state, client.seat, msg.o);
      break;
    }
    case 'addBot': {
      const room = client.room;
      if (room && !room.pub && room.state.phase === 'lobby' && hostId(room) === client.seat) addBot(room, msg.d as BotLevel);
      break;
    }
    case 'removeBot': {
      const room = client.room;
      if (room && !room.pub && hostId(room) === client.seat && room.seats[msg.id]?.bot) {
        freeSeat(room, msg.id);
        room.lastRoster = '';
      }
      break;
    }
    case 'weapon': {
      const room = client.room;
      const seat = room && client.seat !== -1 ? room.seats[client.seat] : null;
      if (!room || !seat || seat.client !== client) break;
      seat.weapon = msg.w;
      setWeapon(room.state, client.seat, msg.w);
      break;
    }
    case 'start': {
      const room = client.room;
      if (!room || room.state.phase !== 'lobby' || hostId(room) !== client.seat) break;
      const ready = room.seats.filter((s) => s?.client || s?.bot).length;
      if (ready >= C.MIN_PLAYERS) startRoomMatch(room);
      break;
    }
    case 'input': {
      const seat = client.room && client.seat !== -1 ? client.room.seats[client.seat] : null;
      if (!seat || seat.client !== client) break;
      // A reconnecting tab starts counting again from 1.
      if (msg.s <= seat.lastSeq && seat.lastSeq - msg.s > 1000) seat.lastSeq = 0;
      if (msg.s <= seat.lastSeq || seat.inputs.some((q) => q.seq >= msg.s)) break;
      seat.inputs.push({
        seq: msg.s,
        input: { forward: msg.f, strafe: msg.r, jump: msg.j, firing: msg.x, sprint: msg.k, crouch: msg.c, aim: msg.z, offhand: msg.o, knife: msg.h, recoil: msg.m, yaw: msg.a, pitch: msg.b },
      });
      // A client far ahead (a burst after a stall): drop the oldest to keep latency down.
      if (seat.inputs.length > C.INPUT_BUFFER_MAX) seat.inputs.splice(0, seat.inputs.length - 2);
      break;
    }
    case 'ping':
      send(client, { t: 'pong', c: msg.c });
      break;
    case 'voice': {
      const seat = client.room && client.seat !== -1 ? client.room.seats[client.seat] : null;
      if (seat && seat.client === client) seat.voice = msg.on;
      break;
    }
    case 'rtc': {
      // Voice chat signalling: only between seated, connected players in the same room.
      const room = client.room;
      if (!room || client.seat === -1 || msg.to === client.seat) break;
      const target = room.seats[msg.to]?.client;
      if (target) send(target, { t: 'rtc', from: client.seat, d: msg.d });
      break;
    }
    case 'leave':
      leaveRoom(client);
      break;
  }
}

// ---------------------------------------------------------------------------
// Message parsing (never trust the client)
// ---------------------------------------------------------------------------

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

function asName(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 64) : '';
}

function asWeapon(v: unknown): number {
  return isWeapon(v) ? v : 0;
}

/** A well-formed WebRTC signal, or null. Only the fields the browser needs are passed on. */
function asRtcSignal(v: unknown): RtcSignal | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const sdp = o.sdp as Record<string, unknown> | undefined;
  if (sdp && typeof sdp === 'object') {
    if ((sdp.type === 'offer' || sdp.type === 'answer') && typeof sdp.sdp === 'string' && sdp.sdp.length < 12000) {
      return { sdp: { type: sdp.type, sdp: sdp.sdp } };
    }
    return null;
  }
  const ice = o.ice as Record<string, unknown> | undefined;
  if (ice && typeof ice === 'object' && typeof ice.candidate === 'string' && ice.candidate.length < 1000) {
    const mid = typeof ice.sdpMid === 'string' ? ice.sdpMid.slice(0, 64) : null;
    const line = typeof ice.sdpMLineIndex === 'number' && Number.isInteger(ice.sdpMLineIndex) ? ice.sdpMLineIndex : null;
    return { ice: { candidate: ice.candidate, sdpMid: mid, sdpMLineIndex: line } };
  }
  return null;
}

function asColor(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < C.PLAYER_PALETTE.length ? v : 0;
}

function parseMessage(data: RawData): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(rawToString(data));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case 'create':
      return isId(m.id) ? { t: 'create', id: m.id, name: asName(m.name), color: asColor(m.color), w: asWeapon(m.w) } : null;
    case 'join': {
      const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
      return ROOM_CODE_PATTERN.test(code) && isId(m.id) ? { t: 'join', code, id: m.id, name: asName(m.name), color: asColor(m.color), w: asWeapon(m.w) } : null;
    }
    case 'quick':
      return isId(m.id) ? { t: 'quick', id: m.id, name: asName(m.name), color: asColor(m.color), w: asWeapon(m.w) } : null;
    case 'weapon':
      return isWeapon(m.w) ? { t: 'weapon', w: m.w } : null;
    case 'offhand':
      return isOffhand(m.o) ? { t: 'offhand', o: m.o } : null;
    case 'addBot':
      return isBotLevel(m.d) ? { t: 'addBot', d: m.d } : null;
    case 'removeBot':
      return typeof m.id === 'number' && Number.isInteger(m.id) && m.id >= 0 && m.id < C.MAX_PLAYERS ? { t: 'removeBot', id: m.id } : null;
    case 'map':
      return typeof m.choice === 'number' && Number.isInteger(m.choice) && m.choice >= -1 && m.choice < MAPS.length
        ? { t: 'map', choice: m.choice }
        : null;
    case 'rules':
      return typeof m.noJump === 'boolean' ? { t: 'rules', noJump: m.noJump, teams: m.teams === true, ctf: m.ctf === true } : null;
    case 'team':
      return m.team === 0 || m.team === 1 ? { t: 'team', team: m.team } : null;
    case 'profile':
      return { t: 'profile', name: asName(m.name), color: asColor(m.color) };
    case 'start':
      return { t: 'start' };
    case 'input': {
      // Keys send -1, 0 or 1; the touch stick sends anything in between.
      const axis = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1 ? v : null);
      const angle = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 10 ? v : null);
      const f = axis(m.f);
      const r = axis(m.r);
      const a = angle(m.a);
      const b = angle(m.b);
      const seq = typeof m.s === 'number' && Number.isInteger(m.s) && m.s > 0 ? m.s : null;
      if (f === null || r === null || a === null || b === null || seq === null) return null;
      if (typeof m.j !== 'boolean' || typeof m.x !== 'boolean' || typeof m.k !== 'boolean' || typeof m.c !== 'boolean') return null;
      return { t: 'input', s: seq, f, r, j: m.j, x: m.x, k: m.k, c: m.c, z: m.z === true, o: m.o === true, h: m.h === true, m: m.m === true, a, b };
    }
    case 'ping':
      return typeof m.c === 'number' && Number.isFinite(m.c) ? { t: 'ping', c: m.c } : null;
    case 'voice':
      return typeof m.on === 'boolean' ? { t: 'voice', on: m.on } : null;
    case 'rtc': {
      const d = asRtcSignal(m.d);
      const to = m.to;
      return d && typeof to === 'number' && Number.isInteger(to) && to >= 0 && to < C.MAX_PLAYERS ? { t: 'rtc', to, d } : null;
    }
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------

/** Rounds numbers to 3 decimals to keep snapshots small. */
function compactReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
}

function send(client: Client, msg: ServerMessage): void {
  sendRaw(client, JSON.stringify(msg, compactReplacer));
}

function sendRaw(client: Client, data: string): void {
  // Skip clients that can't keep up rather than buffering forever.
  if (client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount < 256 * 1024) client.ws.send(data);
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function tickRoom(room: Room, now: number): void {
  const { state, seats } = room;

  // Seats of players who never came back are released.
  seats.forEach((s, id) => {
    if (s && !s.client && !s.bot && now - s.disconnectedAt > C.REJOIN_WINDOW * 1000) freeSeat(room, id);
  });
  // Bots leave once no people are left (seated or reconnecting).
  if (!seats.some((s) => s && !s.bot)) {
    seats.forEach((s, id) => {
      if (s?.bot) freeSeat(room, id);
    });
  }

  // Not enough players left for a match: everyone back to the lobby.
  const seated = seats.filter((s) => s !== null).length;
  if (state.phase !== 'lobby' && seated < C.MIN_PLAYERS) enterLobby(state);

  // Quick play: nobody waits alone. After a few seconds, bots fill the room
  // one at a time (and give up their seats as people join).
  if (room.pub && state.phase === 'lobby') {
    const humans = seats.filter((s) => s?.client).length;
    const total = seats.filter((s) => s?.client || s?.bot).length;
    if (humans === 0 || total >= C.PUBLIC_BOT_FILL) room.botFillAt = null;
    else {
      room.botFillAt ??= now + C.PUBLIC_BOT_DELAY * 1000;
      if (now >= room.botFillAt) {
        addBot(room, Math.random() < 0.25 ? 3 : 2);
        room.botFillAt = now + 1000;
      }
    }
  }

  // Public rooms start by themselves once enough people are in.
  if (room.pub && state.phase === 'lobby') {
    const online = seats.filter((s) => s?.client || s?.bot).length;
    if (online < C.MIN_PLAYERS) room.autoStartAt = null;
    else {
      room.autoStartAt ??= now + C.PUBLIC_START_DELAY * 1000;
      if (online >= C.MAX_PLAYERS) room.autoStartAt = Math.min(room.autoStartAt, now + C.PUBLIC_FULL_START_DELAY * 1000);
      if (now >= room.autoStartAt) startRoomMatch(room);
    }
  }

  // One queued input per player per tick. If a player's queue is empty,
  // their last input is repeated (without acknowledging a new one).
  const inputs = new Map<PlayerId, InputState>();
  seats.forEach((s, id) => {
    if (!s) return;
    if (s.bot) {
      const p = getPlayer(state, id);
      if (p) inputs.set(id, s.bot.think(state, p));
      return;
    }
    const next = s.client ? s.inputs.shift() : undefined;
    if (next) {
      s.lastInput = next.input;
      s.lastSeq = next.seq;
    }
    inputs.set(id, s.lastInput);
    const p = getPlayer(state, id);
    if (p) p.ack = s.lastSeq;
  });
  const events = step(state, inputs);

  const clients = roomClients(room);
  if (clients.length === 0) {
    room.emptySince ??= now;
    if (now - room.emptySince > C.ROOM_EMPTY_TTL * 1000) {
      rooms.delete(room.code);
      log(`room ${room.code} expired (${rooms.size} left)`);
    }
    return;
  }
  room.emptySince = null;

  // Roster only goes out when something in it changed.
  const host = hostId(room);
  const roster: RosterEntry[] = [];
  seats.forEach((s, id) => {
    if (s) {
      roster.push({
        id,
        name: s.name,
        color: s.color,
        score: state.scores[id] ?? 0,
        weapon: s.weapon,
        offhand: s.offhand,
        bot: s.bot ? s.bot.level : 0,
        voice: s.voice && s.client !== null,
        team: state.teams ? (getPlayer(state, id)?.team ?? -1) : -1,
        online: s.client !== null || s.bot !== null,
        host: id === host,
      });
    }
  });
  const startsIn = room.autoStartAt === null ? -1 : Math.max(0, Math.ceil((room.autoStartAt - now) / 1000));
  const rosterMsg = JSON.stringify({
    t: 'roster',
    players: roster,
    spectators: room.spectators.size,
    pub: room.pub,
    mapChoice: state.mapChoice,
    noJump: state.noJump,
    teams: state.teams,
    ctf: state.ctf,
    startsIn,
  } satisfies ServerMessage);
  if (rosterMsg !== room.lastRoster) {
    room.lastRoster = rosterMsg;
    for (const c of clients) sendRaw(c, rosterMsg);
  }

  const snap: Snapshot = {
    t: 'snap',
    k: state.tick,
    ph: state.phase,
    pt: state.phaseTime,
    r: state.arenaRadius,
    m: state.mapIndex,
    p: state.players.filter((p) => p.inRound).map(playerSnap),
    b: state.bullets.map((b): BulletSnap => [b.id, b.owner, b.x, b.y, b.z, b.radius, b.weapon]),
    u: state.powerups.map((u): PowerupSnap => [u.id, POWERUP_KINDS.indexOf(u.kind), u.x, u.y, u.age]),
    e: events,
    rw: state.roundWinner,
    mw: state.matchWinner,
  };
  if (state.teams) {
    snap.ts = state.teamScores;
    snap.tw = state.roundTeam;
    snap.tm = state.matchTeam;
  }
  if (state.ctf) snap.fl = state.flags.map((f) => [f.x, f.y, f.z, f.carrier]);
  const data = JSON.stringify(snap, compactReplacer);
  for (const c of clients) sendRaw(c, data);
}

// Fixed-step accumulator: however late the timer fires, the sim advances in
// exact TICK_DT steps.
let lastTime = performance.now();
let accumulator = 0;
function loop(): void {
  const now = performance.now();
  accumulator += (now - lastTime) / 1000;
  lastTime = now;
  if (accumulator > 0.25) accumulator = 0.25; // don't spiral after a stall
  while (accumulator >= C.TICK_DT) {
    accumulator -= C.TICK_DT;
    const wall = Date.now();
    for (const room of [...rooms.values()]) tickRoom(room, wall);
  }
  setTimeout(loop, Math.max(1, (C.TICK_DT - accumulator) * 1000));
}

// ---------------------------------------------------------------------------
// HTTP (static client) + WebSocket
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveFile(res: http.ServerResponse, file: string, status = 200): void {
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(status, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end(`ok ${rooms.size} rooms`);
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) {
      serveFile(res, file);
      return;
    }
    const index = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(index)) {
      serveFile(res, index);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Client not built. Run "npm run build", or use "npm run dev" and open the Vite URL.');
    }
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
const socketClients = new WeakMap<WebSocket, Client>();

wss.on('connection', (ws) => {
  const client: Client = { ws, id: '', room: null, seat: -1, lastSeen: Date.now() };
  socketClients.set(ws, client);
  ws.on('message', (data) => {
    client.lastSeen = Date.now();
    const msg = parseMessage(data);
    if (msg) handleMessage(client, msg);
  });
  ws.on('close', () => leaveRoom(client));
  ws.on('error', () => ws.terminate());
});

// Heartbeat: drop sockets that have gone quiet (the client pings every second).
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const client = socketClients.get(ws);
    if (client && now - client.lastSeen > C.CLIENT_TIMEOUT_MS) ws.terminate();
  }
}, 5000);

function log(msg: string): void {
  console.log(`[recoil] ${msg}`);
}

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT} (static: ${STATIC_DIR})`);
  loop();
});
