/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional WebSocket URL, e.g. wss://recoil.onrender.com/ws, when the client is hosted elsewhere. */
  readonly VITE_SERVER_URL?: string;
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}
