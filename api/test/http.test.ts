// Tests for the handler wrapper api/src/lib/http.ts (CAP-17): validation → 422 Problem, auth, error mapping, no leaks.
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BadRequest, Conflict, NotFound, NotImplemented } from '../src/lib/errors.js';
import { created, defineHandler, noContent, ok } from '../src/lib/http.js';
import { apiEvent } from './support/fixtures.js';

const body = (res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as Record<string, unknown>;

const echo = defineHandler(
  {
    auth: true,
    body: z.object({ brand: z.string().min(1), quantity: z.number().int().min(1) }).strict(),
    query: z.object({ limit: z.coerce.number().int().max(100).optional() }),
    path: z.object({ capId: z.string().length(4) }),
  },
  async (req) => created({ uid: req.uid, body: req.body, limit: req.query.limit, capId: req.path.capId }),
);

const valid = {
  uid: 'apple-sub-1',
  body: JSON.stringify({ brand: 'Mahou', quantity: 2 }),
  queryStringParameters: { limit: '10' },
  pathParameters: { capId: 'abcd' },
};

afterEach(() => vi.restoreAllMocks());

describe('defineHandler', () => {
  it('[T-api-002] invalid input → 422 Problem with errors[]; unknown error → 500 without leaking; auth route without context → 401', async () => {
    // 422: every invalid part reported with a dotted path, as application/problem+json.
    const bad = await echo(apiEvent({ ...valid, body: JSON.stringify({ brand: '', quantity: 0, extra: 1 }) }));
    expect(bad.statusCode).toBe(422);
    expect(bad.headers?.['content-type']).toBe('application/problem+json');
    const p = body(bad);
    expect(p).toMatchObject({ title: 'Validation failed', status: 422, detail: 'Invalid body' });
    const paths = (p.errors as { path: string; message: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.brand', 'body.quantity', 'body']));

    const badQuery = await echo(apiEvent({ ...valid, queryStringParameters: { limit: '500' } }));
    expect(badQuery.statusCode).toBe(422);
    expect(body(badQuery).errors).toEqual([expect.objectContaining({ path: 'query.limit' })]);

    // 500: generic Problem with the request id; the secret message stays in the (body-free) log only.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = defineHandler({ auth: false }, async () => {
      throw new Error('db password is hunter2');
    });
    const ev = apiEvent({ body: JSON.stringify({ token: 'secret-token' }) });
    const res = await boom(ev);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(body(res)).toEqual({
      title: 'Internal error',
      status: 500,
      detail: `Unexpected error; request id ${ev.requestContext.requestId}`,
    });
    expect(res.headers?.['x-request-id']).toBe(ev.requestContext.requestId);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).not.toContain('secret-token');

    // 401: auth route, no authorizer context; the function never runs.
    const fn = vi.fn(async () => ok({}));
    const guarded = defineHandler({ auth: true }, fn);
    const unauth = await guarded(apiEvent());
    expect(unauth.statusCode).toBe(401);
    expect(body(unauth)).toMatchObject({ status: 401, title: 'Unauthorized' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('[T-api-006] valid request → parsed body/query/path and uid reach the function; reply is uncached JSON', async () => {
    const res = await echo(apiEvent(valid));
    expect(res.statusCode).toBe(201);
    expect(res.headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    expect(body(res)).toEqual({ uid: 'apple-sub-1', body: { brand: 'Mahou', quantity: 2 }, limit: 10, capId: 'abcd' });

    const b64 = await echo(
      apiEvent({ ...valid, isBase64Encoded: true, body: Buffer.from(valid.body).toString('base64') }),
    );
    expect(b64.statusCode).toBe(201);

    const empty = await defineHandler({ auth: false }, async (req) => {
      expect(req.uid).toBeUndefined();
      return noContent();
    })(apiEvent());
    expect(empty).toMatchObject({ statusCode: 204 });
    expect(empty.body).toBeUndefined();

    // Same function type Lambda expects.
    const asLambda: APIGatewayProxyHandlerV2 = echo;
    expect(asLambda).toBe(echo);
  });

  it('[T-api-007] malformed JSON → 400; NotFound → 404, Conflict → 409, NotImplemented → 501, stray ZodError → 422', async () => {
    const malformed = await echo(apiEvent({ ...valid, body: '{"brand":' }));
    expect(malformed.statusCode).toBe(400);
    expect(body(malformed)).toMatchObject({ title: 'Bad request', detail: 'Request body is not valid JSON' });

    const cases: [Error, number][] = [
      [new NotFound('cap 1 not found'), 404],
      [new Conflict('pocket taken'), 409],
      [new NotImplemented('later'), 501],
      [new BadRequest(), 400],
      [z.object({ a: z.string() }).safeParse({}).error as Error, 422],
    ];
    for (const [err, status] of cases) {
      const res = await defineHandler({ auth: false }, async () => {
        throw err;
      })(apiEvent());
      expect(res.statusCode).toBe(status);
      expect(body(res).status).toBe(status);
    }
    const nf = await defineHandler({ auth: false }, async () => {
      throw new NotFound('cap 1 not found');
    })(apiEvent());
    expect(body(nf)).toEqual({ title: 'Not found', status: 404, detail: 'cap 1 not found' });
    const bare = await defineHandler({ auth: false }, async () => {
      throw new BadRequest();
    })(apiEvent());
    expect(body(bare)).toEqual({ title: 'Bad request', status: 400 });

    // Non-Error throwables are still a 500; the request id falls back to the Lambda context, then a fresh ULID.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const weird = defineHandler({ auth: false }, async () => {
      throw 'string thrown';
    });
    const ev = apiEvent();
    (ev.requestContext as { requestId?: string }).requestId = '';
    const viaCtx = await weird(ev, { awsRequestId: 'aws-req-1' } as never);
    expect(viaCtx.headers?.['x-request-id']).toBe('aws-req-1');
    const generated = await weird(ev);
    expect(generated.headers?.['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
