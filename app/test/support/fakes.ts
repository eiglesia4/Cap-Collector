// Test doubles shared by the app tests (CAP-21, CAP-22): in-memory store, fake platform, fake API, a full shell
// context (signed in unless asked otherwise).
import { vi } from 'vitest';

import { createApiClient, type ApiClient } from '../../src/api/client';
import { createApiUrlSetting } from '../../src/api-url';
import type { Session } from '../../src/api/schema';
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
    signInWithApple: vi.fn(async () => null),
    supportsNativeAppleSignIn: () => false,
    onDeepLink: vi.fn(() => () => undefined),
  };
}

export const TEST_SESSION: Session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

/** An ApiClient whose every method is a mock (override the ones a test cares about). */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    request: vi.fn(),
    healthz: vi.fn(async () => ({ status: 'ok' as const })),
    signInWithApple: vi.fn(async () => TEST_SESSION),
    refresh: vi.fn(async () => true),
    ...overrides,
  };
}

export const TEST_CONFIG: AppConfig = {
  apiUrl: 'https://api.test',
  version: '1.2.3',
  dev: true,
  apple: null,
  webUrl: null,
};

export async function shellContext(
  overrides: {
    config?: AppConfig;
    kind?: 'web' | 'native';
    api?: ApiClient;
    platform?: Platform;
    signedIn?: boolean;
  } = {},
): Promise<ShellContext> {
  const config = overrides.config ?? TEST_CONFIG;
  const platform = overrides.platform ?? fakePlatform(overrides.kind);
  const session = createSessionStore(platform.store);
  if (overrides.signedIn ?? true) await session.save(TEST_SESSION);
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
