// `npm run api:local` (CAP-17): the Node server maps routes onto the Lambda handlers with a fake authorizer uid.
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalServer, matchRoute, toEvent, useLocalRepositories } from '../scripts/local-server.js';
import { getRepositories, setRepositories } from '../src/lib/repo/index.js';
import { InMemoryCapRepository, createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { RouteDef } from '../src/routes.js';

const server = createLocalServer('local-user');
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
    const route: RouteDef = {
      method: 'GET',
      path: '/caps/{capId}/history',
      auth: true,
      load: async () => undefined as never,
    };
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
});
