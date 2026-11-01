// Tests for the typed API client: schema parsing, Problem surfacing, refresh-and-retry, sign-out (CAP-21).
import { NextFree } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../src/api/client';
import {
  HttpError,
  NetworkError,
  NotConfiguredError,
  ProblemError,
  ResponseValidationError,
  UnauthorizedError,
} from '../src/api/errors';
import { HealthzSchema, ProblemSchema, SessionSchema } from '../src/api/schema';
import { createSessionStore, SESSION_KEY } from '../src/session/session-store';
import { json, memoryStore } from './support/fakes';

const ALBUM_ID = '01JBCDEFGHJKMNPQRSTVWXYZ01';
const SESSION = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-11-01T22:00:00Z' };
const ROTATED = { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-11-01T23:00:00Z' };

async function setup(responses: Response[] = [], base: string | null = 'https://api.test') {
  const store = memoryStore();
  const session = createSessionStore(store);
  await session.save(SESSION);
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  const api = createApiClient({ baseUrl: () => base, session, fetch });
  const call = (i: number) => {
    const c = fetch.mock.calls[i];
    if (!c) throw new Error(`no call ${i}`);
    const [url, init] = c;
    return { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
  };
  return { api, fetch, session, store, call };
}

describe('API client', () => {
  it('[T-app-004] parses 2xx bodies with the shared zod schemas and surfaces RFC 9457 problems as typed errors', async () => {
    const body = { albumId: ALBUM_ID, location: { kind: 'album', album: 'A', sheet: 3, pocket: 17 }, code: 'A·3·17' };
    const { api, call } = await setup([
      json(200, body),
      json(200, { ...body, albumId: 'not-a-ulid' }),
      json(
        409,
        { type: 'about:blank', title: 'Pocket occupied', status: 409, detail: 'A·3·17 is taken' },
        'application/problem+json',
      ),
      json(422, { title: 'Invalid', status: 422, errors: [{ path: 'brand', message: 'required' }, { other: 1 }] }),
      new Response('<html>bad gateway</html>', { status: 502 }),
      json(500, { message: 'not a problem' }),
      new Response('not json', { status: 200 }),
    ]);

    await expect(api.request(`/albums/${ALBUM_ID}/next-free`, { schema: NextFree })).resolves.toEqual(body);
    expect(call(0).url).toBe(`https://api.test/albums/${ALBUM_ID}/next-free`);
    expect(call(0).init.method).toBe('GET');
    expect(call(0).headers.get('authorization')).toBe('Bearer access-1');
    expect(call(0).headers.get('accept')).toBe('application/json');

    await expect(api.request('/x', { schema: NextFree })).rejects.toBeInstanceOf(ResponseValidationError);

    const conflict = await api
      .request('/caps', { method: 'POST', body: {}, schema: NextFree })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ProblemError);
    expect(conflict).toMatchObject({ status: 409, message: 'A·3·17 is taken', problem: { title: 'Pocket occupied' } });

    const invalid = await api.request('/caps', { schema: NextFree }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({
      status: 422,
      message: 'Invalid',
      problem: { errors: [{ path: 'brand', message: 'required' }, {}] },
    });

    await expect(api.request('/x', { schema: NextFree })).rejects.toEqual(new HttpError(502));
    await expect(api.request('/x', { schema: NextFree })).rejects.toEqual(new HttpError(500));
    await expect(api.request('/x', { schema: NextFree })).rejects.toBeInstanceOf(ResponseValidationError);
  });

  it('[T-app-005] on 401 refreshes once and retries; when refresh fails or the retry is still 401 it signs out', async () => {
    // 401 → refresh OK → retry OK.
    const ok = await setup([json(401, undefined), json(200, ROTATED), json(200, { status: 'ok' })]);
    await expect(ok.api.request('/caps', { schema: HealthzSchema })).resolves.toEqual({ status: 'ok' });
    expect(ok.call(1).url).toBe('https://api.test/auth/refresh');
    expect(JSON.parse(String(ok.call(1).init.body))).toEqual({ refreshToken: 'refresh-1' });
    expect(ok.call(1).headers.get('authorization')).toBeNull();
    expect(ok.call(2).headers.get('authorization')).toBe('Bearer access-2');
    expect(ok.session.current()).toEqual(ROTATED);
    expect(JSON.parse(ok.store.data.get(SESSION_KEY) ?? '')).toEqual(ROTATED);

    // 401 → refresh rejected → signed out, no retry.
    const rejected = await setup([json(401, undefined), json(401, undefined)]);
    const signedOut = vi.fn();
    rejected.session.subscribe(signedOut);
    await expect(rejected.api.request('/caps', { schema: HealthzSchema })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(rejected.fetch).toHaveBeenCalledTimes(2);
    expect(rejected.session.signedIn()).toBe(false);
    expect(rejected.store.data.has(SESSION_KEY)).toBe(false);
    expect(signedOut).toHaveBeenCalledWith(false);

    // 401 → refresh OK → retry 401 again → signed out (only one refresh).
    const again = await setup([json(401, undefined), json(200, ROTATED), json(401, undefined)]);
    await expect(again.api.request('/caps', { schema: HealthzSchema })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(again.fetch).toHaveBeenCalledTimes(3);
    expect(again.session.signedIn()).toBe(false);

    // No session at all: nothing to refresh with.
    const none = await setup([json(401, undefined)]);
    await none.session.signOut();
    await expect(none.api.request('/caps', { schema: HealthzSchema })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(none.call(0).headers.get('authorization')).toBeNull();
    expect(none.fetch).toHaveBeenCalledTimes(1);
  });

  it('[T-app-015] shares one refresh between concurrent 401s, skips auth for /healthz and types config and network failures', async () => {
    const { api, fetch, call } = await setup([
      json(401, undefined),
      json(401, undefined),
      json(200, ROTATED),
      json(200, { status: 'ok' }),
      json(200, { status: 'ok' }),
    ]);
    const results = await Promise.all([
      api.request('/a', { schema: HealthzSchema }),
      api.request('/b', { schema: HealthzSchema }),
    ]);
    expect(results).toEqual([{ status: 'ok' }, { status: 'ok' }]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(call(3).headers.get('authorization')).toBe('Bearer access-2');

    // /healthz: no bearer, no refresh on 401.
    const health = await setup([json(200, { status: 'ok' }), json(401, undefined)]);
    await expect(health.api.healthz()).resolves.toEqual({ status: 'ok' });
    expect(health.call(0).url).toBe('https://api.test/healthz');
    expect(health.call(0).headers.get('authorization')).toBeNull();
    await expect(health.api.healthz()).rejects.toEqual(new HttpError(401));
    expect(health.session.signedIn()).toBe(true);

    // JSON body + 204.
    const write = await setup([new Response(null, { status: 204 })]);
    const accepted = { safeParse: (d: unknown) => ({ success: true as const, data: d }) };
    await expect(
      write.api.request('/caps/x', { method: 'DELETE', body: { a: 1 }, schema: accepted }),
    ).resolves.toBeUndefined();
    expect(write.call(0).headers.get('content-type')).toBe('application/json');
    expect(write.call(0).init.body).toBe('{"a":1}');

    // Refresh answered with a malformed session: validation error, the session is kept.
    const bad = await setup([json(401, undefined), json(200, { accessToken: 'x' })]);
    await expect(bad.api.request('/caps', { schema: HealthzSchema })).rejects.toBeInstanceOf(ResponseValidationError);
    expect(bad.session.signedIn()).toBe(true);

    const unconfigured = await setup([], null);
    await expect(unconfigured.api.healthz()).rejects.toBeInstanceOf(NotConfiguredError);
    expect(unconfigured.fetch).not.toHaveBeenCalled();

    const offline = await setup();
    offline.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(offline.api.healthz()).rejects.toBeInstanceOf(NetworkError);
  });

  it('[T-app-018] validates Problem, Session and healthz bodies exactly as openapi.yaml describes them', () => {
    expect(ProblemSchema.safeParse({ title: 'x', status: 400, type: 't', detail: 'd' })).toEqual({
      success: true,
      data: { title: 'x', status: 400, type: 't', detail: 'd' },
    });
    for (const bad of [
      null,
      [],
      { status: 400 },
      { title: 'x', status: 4.5 },
      { title: 'x', status: 400, type: 1 },
      { title: 'x', status: 400, detail: 1 },
      { title: 'x', status: 400, errors: {} },
      { title: 'x', status: 400, errors: ['e'] },
    ]) {
      expect(ProblemSchema.safeParse(bad).success).toBe(false);
    }
    expect(SessionSchema.safeParse(SESSION)).toEqual({ success: true, data: SESSION });
    for (const bad of [
      'x',
      { ...SESSION, accessToken: '' },
      { ...SESSION, refreshToken: 1 },
      { ...SESSION, expiresAt: 'tomorrow' },
    ]) {
      expect(SessionSchema.safeParse(bad).success).toBe(false);
    }
    expect(HealthzSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(HealthzSchema.safeParse({ status: 'down' }).success).toBe(false);
  });
});
