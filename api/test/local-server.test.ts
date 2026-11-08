// `npm run api:local` (CAP-17): the Node server maps the shared route manifest (CAP-30) onto the Lambda handlers with a
// fake authorizer uid; routes whose handler has not landed answer 501.
import { readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { ROUTES, type RouteDef } from '@capcollector/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HANDLERS_DIR,
  createLocalServer,
  hasHandler,
  matchRoute,
  toEvent,
  useLocalRepositories,
} from '../scripts/local-server.js';
import { getRepositories, setRepositories } from '../src/lib/repo/index.js';
import { InMemoryCapRepository, createMemoryRepositories } from '../src/lib/repo/memory.js';
import { newId } from '../src/lib/ids.js';
import { type VisionAdapter, setVisionAdapter } from '../src/lib/vision/adapter.js';
import { useAwsTestEnv } from './support/aws-env.js';

useAwsTestEnv();

/**
 * Contract routes whose handler belongs to a later story (V3 location). SPEC-GAP CAP-30: the
 * story asks for "every ROUTES[].handler has a file", which cannot hold until those stories land; this list must
 * shrink as each one merges (T-api-039 fails if a listed handler appears or an unlisted one is missing).
 */
const NOT_YET_LANDED = ['caps-location-put', 'caps-location-delete'];

const server = createLocalServer({ mode: 'fake', defaultUid: 'local-user' });
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  setRepositories(undefined);
});

describe('api:local', () => {
  it('[T-api-012] GET /healthz answers 200 ok; unknown routes answer a 404 Problem; repos are in memory without an endpoint', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok' });

    const missing = await fetch(`${base}/nope`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    expect(await missing.json()).toMatchObject({ status: 404, detail: 'No route POST /nope' });

    expect(useLocalRepositories({})).toBe('memory');
    expect(getRepositories().caps).toBeInstanceOf(InMemoryCapRepository);
    expect(useLocalRepositories({ CAP_DYNAMODB_ENDPOINT: 'http://localhost:8000' })).toBe('dynamodb-local');
  });

  it('[T-api-013] path templates bind parameters; auth routes get the fake uid in the authorizer context, public ones none', () => {
    const route: RouteDef = { method: 'GET', path: '/caps/{capId}/history', handler: 'caps-history', auth: true };
    const m = matchRoute('GET', '/caps/01J%20X/history', [route]);
    expect(m?.params).toEqual({ capId: '01J X' });
    expect(matchRoute('POST', '/caps/1/history', [route])).toBeUndefined();
    expect(matchRoute('GET', '/caps/1', [route])).toBeUndefined();
    expect(matchRoute('GET', '/albums/1/history', [route])).toBeUndefined();

    const url = new URL('http://localhost/caps/1/history?limit=5');
    const ev = toEvent({ method: 'GET', url, headers: {}, body: '{"a":1}' }, m!, 'apple-sub-1');
    expect(ev).toMatchObject({
      routeKey: 'GET /caps/{capId}/history',
      rawPath: '/caps/1/history',
      queryStringParameters: { limit: '5' },
      pathParameters: { capId: '01J X' },
      body: '{"a":1}',
      requestContext: { authorizer: { lambda: { uid: 'apple-sub-1' } } },
    });
    const pub = toEvent(
      { method: 'GET', url: new URL('http://localhost/healthz'), headers: {}, body: undefined },
      { route: { ...route, auth: false }, params: {} },
      'x',
    );
    expect(pub.requestContext).not.toHaveProperty('authorizer');
    expect(pub).not.toHaveProperty('queryStringParameters');
    expect(pub).not.toHaveProperty('body');
  });

  it('[T-api-024] every /caps* route answers over HTTP on api:local: create, list, get, patch, history, delete, per-user 404', async () => {
    setRepositories(createMemoryRepositories());
    const call = async (method: string, path: string, body?: unknown, uid?: string) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(uid ? { 'x-cap-uid': uid } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
    };
    const images = { top: { key: 'local-user/x/top.webp', width: 640, height: 640 } };
    const made = await call('POST', '/caps', { brand: 'Mahou', variant: 'Clásica', images });
    expect(made.status).toBe(201);
    const capId = String(made.body?.capId);

    const page = await call('GET', '/caps?q=clasica&sort=newest&limit=5');
    expect(page).toMatchObject({ status: 200, body: { total: 1, items: [{ capId }] } });
    expect((await call('GET', `/caps/${capId}`)).body).toMatchObject({ brand: 'Mahou' });
    expect((await call('PATCH', `/caps/${capId}`, { year: 2021 })).body).toMatchObject({ year: 2021 });
    const hist = await call('GET', `/caps/${capId}/history`);
    expect((hist.body as unknown as { action: string }[]).map((h) => h.action)).toEqual(['updated', 'created']);
    expect((await call('GET', `/caps/${capId}`, undefined, 'someone-else')).status).toBe(404);
    expect((await call('DELETE', `/caps/${capId}`)).status).toBe(204);
    expect((await call('GET', `/caps/${capId}`)).status).toBe(404);
    expect((await call('POST', '/caps', { brand: 'X', images, location: { kind: 'box', album: 'B' } })).status).toBe(
      422,
    );
  });

  it('[T-api-039] handlers ↔ shared ROUTES: every handler file is a contract route, every route has a file or is a listed later story (501 locally)', async () => {
    const files = readdirSync(HANDLERS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .sort();
    const routeHandlers = ROUTES.map((r) => r.handler);
    expect(files.filter((f) => !routeHandlers.includes(f))).toEqual([]);
    expect(routeHandlers.filter((h) => !hasHandler(h)).sort()).toEqual([...NOT_YET_LANDED].sort());
    // The local server serves exactly the shared manifest: a contract route without a handler yet → 501 Problem.
    const res = await fetch(`${base}/caps/01JBF6Z3Q8K2M4N6P8R0S2T4V6/location`, { method: 'DELETE' });
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 501, title: 'Not implemented' });
  });

  it('[T-api-050] api:local scans flow: analyse → save the cap → the same dHash again is a duplicate without the adapter; GET /scans lists both', async () => {
    setRepositories(createMemoryRepositories());
    const identify = vi.fn<VisionAdapter['identify']>(async () => ({ status: 'unavailable', reason: 'stub' }));
    setVisionAdapter({ identify });
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const dhash = 'a3f0c81e7b2d9f44';
    const top = `local-user/${newId()}/top.webp`;

    const first = await post('/scans/analyse', { scanId: newId(), dhash, imageKeys: { top } });
    expect(first.status).toBe(503);
    expect(identify).toHaveBeenCalledTimes(1);
    const cap = await post('/caps', { brand: 'Mahou', dhash, images: { top: { key: top, width: 640, height: 640 } } });
    expect(cap.status).toBe(201);

    const second = await post('/scans/analyse', { scanId: newId(), dhash, imageKeys: { top } });
    expect(second).toMatchObject({
      status: 200,
      body: { outcome: 'duplicate', match: { capId: cap.body.capId, by: 'dhash' } },
    });
    expect(identify).toHaveBeenCalledTimes(1);

    const list = (await (await fetch(`${base}/scans`)).json()) as { items: { outcome: string; aiCalled: boolean }[] };
    expect(list.items.map((s) => [s.outcome, s.aiCalled])).toEqual([
      ['duplicate', false],
      ['unidentified', true],
    ]);
    setVisionAdapter(undefined);
  });

  it('[T-api-057] api:local exchange flow: create → answered → reviewed round-trips and GET /exchange/requests reflects each step', async () => {
    setRepositories(createMemoryRepositories());
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const statuses = async (q = '') =>
      ((await send('GET', `/exchange/requests${q}`)).body as unknown as { requestId: string; status: string }[]).map(
        (i) => i.status,
      );
    const requestId = newId();

    expect(await send('POST', '/exchange/requests', { requestId, dhash: 'a3f0c81e7b2d9f44' })).toMatchObject({
      status: 201,
      body: { requestId, status: 'waiting' },
    });
    expect(await statuses()).toEqual(['waiting']);

    expect(
      await send('PATCH', `/exchange/requests/${requestId}`, { status: 'answered', provider: 'gemini' }),
    ).toMatchObject({ status: 200, body: { status: 'answered', provider: 'gemini' } });
    expect(await statuses()).toEqual(['answered']);
    expect(await statuses('?status=waiting')).toEqual([]);

    expect(await send('PATCH', `/exchange/requests/${requestId}`, { status: 'reviewed' })).toMatchObject({
      status: 200,
      body: { status: 'reviewed', provider: 'gemini' },
    });
    expect(await statuses('?status=reviewed')).toEqual(['reviewed']);
    expect((await send('PATCH', `/exchange/requests/${requestId}`, { status: 'reviewed' })).status).toBe(409);
  });
});
