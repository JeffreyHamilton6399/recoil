// Thin WebSocket wrapper. The server lives on the same host at /ws unless
// VITE_SERVER_URL is set at build time (for hosting the client separately).

import type { ClientMessage, ServerMessage } from '../shared/types.js';

export interface NetHandlers {
  onOpen(): void;
  onClose(): void;
  onMessage(msg: ServerMessage): void;
}

function serverUrl(): string {
  const secure = location.protocol === 'https:';
  const configured = (import.meta.env.VITE_SERVER_URL ?? '').trim();
  if (!configured) return `${secure ? 'wss:' : 'ws:'}//${location.host}/ws`;
  // Forgive common mistakes: an http(s):// address, ws:// on an https page,
  // a bare host name, or a missing /ws path.
  let url = configured.replace(/^http(s?):\/\//i, 'ws$1://');
  if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
  if (secure) url = url.replace(/^ws:\/\//i, 'wss://');
  url = url.replace(/\/+$/, '');
  if (!/\/ws$/.test(url)) url += '/ws';
  return url;
}

export class Net {
  private ws: WebSocket | null = null;

  constructor(private readonly handlers: NetHandlers) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens a connection if there isn't one already. */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl());
    } catch (err) {
      console.error('[recoil] bad server URL', err);
      this.handlers.onClose();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.handlers.onOpen();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onClose();
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws || typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(msg);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
