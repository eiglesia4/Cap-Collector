// Test doubles shared by the app tests (CAP-21): in-memory store, fake platform, a full shell context.
import { vi } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import { createApiUrlSetting } from '../../src/api-url';
import type { ShellContext } from '../../src/app';
import type { AppConfig } from '../../src/config';
import type { KeyValueStore, Platform } from '../../src/platform/platform';
import { createSessionStore } from '../../src/session/session-store';

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

export function fakePlatform(kind: 'web' | 'native' = 'native', store = memoryStore()): Platform {
  return {
    kind,
    camera: vi.fn(async () => null),
    pickFiles: vi.fn(async () => []),
    share: vi.fn(async () => false),
    store,
  };
}

export const TEST_CONFIG: AppConfig = { apiUrl: 'https://api.test', version: '1.2.3', dev: true };

export function shellContext(
  overrides: { config?: AppConfig; kind?: 'web' | 'native'; api?: ApiClient } = {},
): ShellContext {
  const config = overrides.config ?? TEST_CONFIG;
  const platform = fakePlatform(overrides.kind);
  const session = createSessionStore(platform.store);
  const apiUrl = createApiUrlSetting(config, platform.store);
  const api = overrides.api ?? createApiClient({ baseUrl: apiUrl.current, session, fetch: vi.fn() });
  return { config, platform, session, api, apiUrl };
}

export function json(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  });
}

/** Resolves after pending promise callbacks have run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
