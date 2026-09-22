// Thin WebSocket wrapper. The server lives on the same host at /ws unless
// VITE_SERVER_URL is set at build time (for hosting the client separately).

import type { ClientMessage, ServerMessage } from '../shared/types.js';

export interface NetHandlers {
  onOpen(): void;
  onClose(): void;
  onMessage(msg: ServerMessage): void;
}

function serverUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
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
    const ws = new WebSocket(serverUrl());
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
