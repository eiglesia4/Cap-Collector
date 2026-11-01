// `npm run api:local` (CAP-17): the Node server maps routes onto the Lambda handlers with a fake authorizer uid.
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalServer, matchRoute, toEvent, useLocalRepositories } from '../scripts/local-server.js';
import { getRepositories, setRepositories } from '../src/lib/repo/index.js';
import { InMemoryCapRepository } from '../src/lib/repo/memory.js';
import type { RouteDef } from '../src/routes.js';

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
});
