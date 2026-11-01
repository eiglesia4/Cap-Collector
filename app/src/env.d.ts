// Ambient types for build-time values: Vite env variables and the version injected by vite.config.ts (CAP-21).
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
