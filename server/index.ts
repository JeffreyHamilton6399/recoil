// RECOIL server: serves the built client over HTTP, hosts rooms over
// WebSocket at /ws, and runs every room's simulation at a fixed 30Hz.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as C from '../shared/constants.js';
import { NO_INPUT, createGame, playerSnap, startMatch, startRound, step } from '../shared/sim.js';
import {
  ROOM_CODE_PATTERN,
  type BulletSnap,
  type ClientMessage,
  type GameEvent,
  type GameState,
  type InputState,
  type PlayerIndex,
  type ServerMessage,
  type SlotStatus,
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
  /** Random id the browser keeps per tab, used to reclaim a slot after a drop. */
  id: string;
  room: Room | null;
  slot: PlayerIndex | -1;
  lastSeen: number;
}

interface Slot {
  clientId: string;
  client: Client | null;
  input: InputState;
  /** Set when fire is pressed, so a tap shorter than one tick still registers. */
  fireLatch: boolean;
  disconnectedAt: number;
}

interface Room {
  code: string;
  state: GameState;
  slots: [Slot | null, Slot | null];
  spectators: Set<Client>;
  rematch: [boolean, boolean];
  emptySince: number | null;
}

const rooms = new Map<string, Room>();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L or O: easy to read aloud

function newRoomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function createRoom(): Room {
  const room: Room = {
    code: newRoomCode(),
    state: createGame(),
    slots: [null, null],
    spectators: new Set(),
    rematch: [false, false],
    emptySince: null,
  };
  rooms.set(room.code, room);
  log(`room ${room.code} created (${rooms.size} total)`);
  return room;
}

function closeRoom(room: Room, msg: string): void {
  for (const c of roomClients(room)) {
    send(c, { t: 'closed', msg });
    c.room = null;
    c.slot = -1;
  }
  rooms.delete(room.code);
  log(`room ${room.code} closed: ${msg} (${rooms.size} left)`);
}

function roomClients(room: Room): Client[] {
  const out: Client[] = [...room.spectators];
  for (const s of room.slots) if (s?.client) out.push(s.client);
  return out;
}

function joinRoom(client: Client, room: Room): void {
  leaveRoom(client);
  const { slots } = room;
  const pick = (pred: (s: Slot | null) => boolean): PlayerIndex | -1 => (pred(slots[0]) ? 0 : pred(slots[1]) ? 1 : -1);

  // Prefer your own old slot, then an empty one, then any abandoned one.
  let slot = pick((s) => s !== null && s.clientId === client.id);
  if (slot === -1) slot = pick((s) => s === null);
  if (slot === -1) slot = pick((s) => s !== null && s.client === null);

  client.room = room;
  client.slot = slot;
  if (slot === -1) {
    room.spectators.add(client);
  } else {
    const prev = slots[slot];
    // Same browser reconnecting before we noticed its old socket died: take over.
    if (prev?.client && prev.client !== client) {
      prev.client.room = null;
      prev.client.slot = -1;
      prev.client.ws.close();
    }
    const wasAbandoned = prev !== null && prev.client === null;
    slots[slot] = { clientId: client.id, client, input: { ...NO_INPUT }, fireLatch: false, disconnectedAt: 0 };
    // Coming back mid-round restarts that round so nobody gets a cheap KO.
    const ph = room.state.phase;
    if (wasAbandoned && (ph === 'countdown' || ph === 'playing')) startRound(room.state);
  }
  send(client, { t: 'joined', code: room.code, slot });
  log(`room ${room.code}: ${slot === -1 ? 'spectator' : `player ${slot + 1}`} joined`);
}

function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  if (client.slot === -1) {
    room.spectators.delete(client);
  } else {
    const slot = room.slots[client.slot];
    if (slot && slot.client === client) {
      if (room.state.phase === 'waiting') {
        // Match never started, so just free the seat.
        room.slots[client.slot] = null;
      } else {
        slot.client = null;
        slot.input = { ...NO_INPUT };
        slot.fireLatch = false;
        slot.disconnectedAt = Date.now();
      }
    }
  }
  client.room = null;
  client.slot = -1;
}

function handleMessage(client: Client, msg: ClientMessage): void {
  switch (msg.t) {
    case 'create':
      client.id = msg.id;
      joinRoom(client, createRoom());
      break;
    case 'join': {
      client.id = msg.id;
      const room = rooms.get(msg.code);
      if (room) joinRoom(client, room);
      else send(client, { t: 'error', msg: `Room ${msg.code} not found. It may have expired.` });
      break;
    }
    case 'input': {
      const slot = client.room && client.slot !== -1 ? client.room.slots[client.slot] : null;
      if (!slot || slot.client !== client) break;
      if (msg.f && !slot.input.firing) slot.fireLatch = true;
      slot.input = { aimLeft: msg.l, aimRight: msg.r, firing: msg.f };
      break;
    }
    case 'ping':
      send(client, { t: 'pong', c: msg.c });
      break;
    case 'rematch': {
      const room = client.room;
      if (room && client.slot !== -1 && room.state.phase === 'matchEnd') room.rematch[client.slot] = true;
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
      return isId(m.id) ? { t: 'create', id: m.id } : null;
    case 'join': {
      const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
      return ROOM_CODE_PATTERN.test(code) && isId(m.id) ? { t: 'join', code, id: m.id } : null;
    }
    case 'input':
      return typeof m.l === 'boolean' && typeof m.r === 'boolean' && typeof m.f === 'boolean'
        ? { t: 'input', l: m.l, r: m.r, f: m.f }
        : null;
    case 'ping':
      return typeof m.c === 'number' && Number.isFinite(m.c) ? { t: 'ping', c: m.c } : null;
    case 'rematch':
      return { t: 'rematch' };
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

function slotStatus(s: Slot | null): SlotStatus {
  return s === null ? 0 : s.client ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function tickRoom(room: Room, now: number): void {
  const { state, slots } = room;
  const connected = slots.map((s) => s?.client != null);
  const bothConnected = connected[0] && connected[1];

  if (state.phase === 'waiting' && bothConnected) startMatch(state);
  if (state.phase !== 'matchEnd') room.rematch = [false, false];
  if (state.phase === 'matchEnd' && room.rematch[0] && room.rematch[1]) {
    room.rematch = [false, false];
    startMatch(state);
  }

  let events: GameEvent[] = [];
  if (state.phase !== 'waiting' && bothConnected) {
    const inputs = slots.map((s): InputState => {
      if (!s) return NO_INPUT;
      return { ...s.input, firing: s.input.firing || s.fireLatch };
    }) as [InputState, InputState];
    events = step(state, inputs);
    for (const s of slots) if (s) s.fireLatch = false;
  } else {
    // Paused or waiting: keep the tick counting so it still works as a clock.
    state.tick++;
  }

  // A player dropped: give them REJOIN_WINDOW seconds to come back.
  let closesIn: number | null = null;
  if (state.phase !== 'waiting') {
    for (const s of slots) {
      if (s && !s.client) {
        const left = C.REJOIN_WINDOW - (now - s.disconnectedAt) / 1000;
        closesIn = closesIn === null ? left : Math.min(closesIn, left);
      }
    }
  }
  if (closesIn !== null && closesIn <= 0) {
    closeRoom(room, 'Your opponent did not come back.');
    return;
  }

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

  const snap: Snapshot = {
    t: 'snap',
    k: state.tick,
    ph: state.phase,
    pt: state.phaseTime,
    r: state.arenaRadius,
    s: state.scores,
    p: [playerSnap(state.players[0]), playerSnap(state.players[1])],
    b: state.bullets.map((b): BulletSnap => [b.id, b.owner, b.x, b.y, b.radius]),
    e: events,
    rr: state.roundResult,
    mw: state.matchWinner,
    sl: [slotStatus(slots[0]), slotStatus(slots[1])],
    cl: closesIn === null ? -1 : Math.ceil(closesIn),
    rm: room.rematch,
    sp: room.spectators.size,
  };
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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

const socketClients = new WeakMap<WebSocket, Client>();

wss.on('connection', (ws) => {
  const client: Client = { ws, id: '', room: null, slot: -1, lastSeen: Date.now() };
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
