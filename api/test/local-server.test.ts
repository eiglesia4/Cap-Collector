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
      404,
    );
  });

  it('[T-api-039] handlers ↔ shared ROUTES: every handler file is a contract route and every route has its file (since CAP-50); a route without one answers 501 locally', async () => {
    const files = readdirSync(HANDLERS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3))
      .sort();
    const routeHandlers = ROUTES.map((r) => r.handler);
    expect(files.filter((f) => !routeHandlers.includes(f))).toEqual([]);
    expect(routeHandlers.filter((h) => !hasHandler(h))).toEqual([]);
    // A route the architect publishes ahead of its handler → 501 Problem, as the deployed stub does (CAP-30).
    const ahead = createLocalServer({ mode: 'fake', defaultUid: 'local-user' }, [
      { method: 'GET', path: '/later', handler: 'not-landed-yet', auth: false },
    ]);
    await new Promise<void>((r) => ahead.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(ahead.address() as AddressInfo).port}/later`);
      expect(res.status).toBe(501);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(await res.json()).toMatchObject({ status: 501, title: 'Not implemented' });
    } finally {
      await new Promise((r) => ahead.close(r));
    }
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

  it('[T-api-085] api:local (CAP-63 done when): analyse with useAi=false and known.brand of an existing cap → duplicate by brand, adapter not called', async () => {
    setRepositories(createMemoryRepositories());
    const identify = vi.fn<VisionAdapter['identify']>(async () => ({ status: 'unavailable', reason: 'stub' }));
    setVisionAdapter({ identify });
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const top = `local-user/${newId()}/top.webp`;
    const cap = await post('/caps', {
      brand: 'Mahou',
      variant: 'Clásica',
      dhash: 'a3f0c81e7b2d9f44',
      images: { top: { key: top, width: 640, height: 640 } },
    });
    expect(cap.status).toBe(201);

    const res = await post('/scans/analyse', {
      scanId: newId(),
      dhash: '5c0f37e184d260bb',
      imageKeys: { top: `local-user/${newId()}/top.webp` },
      useAi: false,
      known: { brand: 'Mahou', variant: 'Clásica' },
    });
    expect(res).toMatchObject({
      status: 200,
      body: { outcome: 'duplicate', match: { capId: cap.body.capId, by: 'brand' } },
    });
    expect(identify).not.toHaveBeenCalled();
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
  it('[T-api-079] api:local, album A: two caps cannot share A·1·1, one swap call exchanges them, the sheet view reflects it', async () => {
    setRepositories(createMemoryRepositories());
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
    };
    const album = await send('POST', '/albums', { letter: 'A', name: 'Leuchtturm GRANDE', kind: 'album', sheets: 10 });
    expect(album.status).toBe(201);
    const albumId = String(album.body?.albumId);
    const images = { top: { key: 'local-user/x/top.webp', width: 640, height: 640 } };
    const a11 = { kind: 'album', album: 'A', sheet: 1, pocket: 1 };
    const first = await send('POST', '/caps', { brand: 'Mahou', images, location: a11 });
    expect(first.status).toBe(201);
    const second = await send('POST', '/caps', { brand: 'Alhambra', images });
    const [one, two] = [String(first.body?.capId), String(second.body?.capId)];

    expect((await send('PUT', `/caps/${two}/location`, { location: a11 })).status).toBe(409);
    expect((await send('PUT', `/caps/${one}/location`, { location: { ...a11, pocket: 2 } })).status).toBe(200);
    expect((await send('PUT', `/caps/${two}/location`, { location: { ...a11, pocket: 1 } })).status).toBe(200);
    const swap = await send('PUT', `/caps/${two}/location`, { location: { ...a11, pocket: 2 }, swap: true });
    expect(swap.status).toBe(200);
    expect(swap.body).toMatchObject({ cap: { capId: two }, swapped: { capId: one } });

    const view = await send('GET', `/albums/${albumId}/sheets/1`);
    expect(view.status).toBe(200);
    expect((view.body?.pockets as { pocket: number; capId: string }[]).map((p) => [p.pocket, p.capId])).toEqual([
      [1, one],
      [2, two],
    ]);
    expect((await send('GET', `/albums/${albumId}/next-free`)).body).toMatchObject({ code: 'A·1·3' });
    expect((await send('DELETE', `/caps/${one}/location`)).status).toBe(204);
    expect((await send('GET', `/albums/${albumId}/next-free`)).body).toMatchObject({ code: 'A·1·1' });
  });
});
