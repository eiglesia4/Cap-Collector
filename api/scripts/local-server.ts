// `npm run api:local` (CAP-17): a plain Node http server that turns requests into API Gateway HTTP API v2 events and
// runs the Lambda handlers named by the shared route manifest (`ROUTES`, contracts v0.2) in-process; a route whose
// handler has not landed yet answers the 501 Problem, as the deployed stub does (CAP-30). Repositories: in memory, or DynamoDB Local when
// CAP_DYNAMODB_ENDPOINT is set (deploy/docker-compose.yaml + `npm run db:create`). Auth: with CAP_STAGE=local the
// `x-cap-uid` header (default CAP_LOCAL_UID or "local-user") stands in for the authorizer; otherwise the real
// authorizer checks the session JWT (CAP-19). Never deployed.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROUTES, type RouteDef } from '@capcollector/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { handler as authorizer } from '../src/auth/authorizer.js';

import { AUTHORIZER_UID_KEY, type Handler, problem } from '../src/lib/http.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import { setRepositories } from '../src/lib/repo/index.js';

export const LOCAL_UID_HEADER = 'x-cap-uid';

/** api/src/handlers/ — one file per `RouteDef.handler` (CLAUDE.md § api). */
export const HANDLERS_DIR = fileURLToPath(new URL('../src/handlers/', import.meta.url));

/** True when `api/src/handlers/<name>.ts` exists. */
export const hasHandler = (name: string, dir: string = HANDLERS_DIR) => existsSync(`${dir}${name}.ts`);

/** Loads a route's handler module; `undefined` while its story has not landed (→ 501, like the deployed stub). */
export async function loadHandler(route: RouteDef): Promise<Handler | undefined> {
  if (!hasHandler(route.handler)) return undefined;
  // The .ts file URL works under tsx (`npm run api:local`) and vitest alike; the name comes from the shared manifest.
  const url = pathToFileURL(`${HANDLERS_DIR}${route.handler}.ts`).href;
  return ((await import(/* @vite-ignore */ url)) as { handler: Handler }).handler;
}

interface Match {
  route: RouteDef;
  params: Record<string, string>;
}

/** Matches `/caps/01J…` against `/caps/{capId}`. */
export function matchRoute(method: string, path: string, routes: readonly RouteDef[] = ROUTES): Match | undefined {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const tpl = route.path.split('/').filter(Boolean);
    if (tpl.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const hit = tpl.every((t, i) => {
      const p = parts[i] ?? '';
      if (t.startsWith('{') && t.endsWith('}')) {
        params[t.slice(1, -1)] = decodeURIComponent(p);
        return true;
      }
      return t === p;
    });
    if (hit) return { route, params };
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

export function toEvent(
  req: { method: string; url: URL; headers: Record<string, string>; body: string | undefined },
  m: Match,
  uid: string | undefined,
): APIGatewayProxyEventV2 {
  const query = Object.fromEntries(req.url.searchParams);
  return {
    version: '2.0',
    routeKey: `${m.route.method} ${m.route.path}`,
    rawPath: req.url.pathname,
    rawQueryString: req.url.searchParams.toString(),
    headers: req.headers,
    ...(Object.keys(query).length ? { queryStringParameters: query } : {}),
    ...(Object.keys(m.params).length ? { pathParameters: m.params } : {}),
    ...(req.body === undefined ? {} : { body: req.body }),
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      requestId: randomUUID(),
      routeKey: `${m.route.method} ${m.route.path}`,
      stage: '$default',
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
      http: {
        method: m.route.method,
        path: req.url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: '',
      },
      ...(m.route.auth && uid ? { authorizer: { lambda: { [AUTHORIZER_UID_KEY]: uid } } } : {}),
    } as APIGatewayProxyEventV2['requestContext'],
  };
}

export type LocalAuth = { mode: 'fake'; defaultUid?: string } | { mode: 'authorizer' };

/**
 * Auth for protected routes (CAP-19): `fake` takes the uid from `x-cap-uid` (or `defaultUid`) and is only chosen when
 * CAP_STAGE=local; `authorizer` runs the real Lambda authorizer on `Authorization: Bearer …`, answering like API
 * Gateway does (no header → 401, denied → 403).
 */
async function resolveUid(
  auth: LocalAuth,
  headers: Record<string, string>,
): Promise<{ uid?: string; deny?: APIGatewayProxyStructuredResultV2 }> {
  if (auth.mode === 'fake') {
    const uid = headers[LOCAL_UID_HEADER] ?? auth.defaultUid;
    return uid ? { uid } : {};
  }
  if (!headers.authorization) return { deny: problem({ title: 'Unauthorized', status: 401 }, 'local') };
  const r = await authorizer({ headers });
  return r.isAuthorized ? { uid: r.context.uid } : { deny: problem({ title: 'Forbidden', status: 403 }, 'local') };
}

export function localAuthFor(env: NodeJS.ProcessEnv = process.env): LocalAuth {
  return env.CAP_STAGE === 'local'
    ? { mode: 'fake', defaultUid: env.CAP_LOCAL_UID || 'local-user' }
    : { mode: 'authorizer' };
}

export function createLocalServer(
  auth: LocalAuth = localAuthFor(),
  routes: readonly RouteDef[] = ROUTES,
  load: (route: RouteDef) => Promise<Handler | undefined> = loadHandler,
): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const body = await readBody(req);
      const m = matchRoute(method, url.pathname, routes);
      let result: APIGatewayProxyStructuredResultV2;
      if (!m) {
        result = problem({ title: 'Not found', status: 404, detail: `No route ${method} ${url.pathname}` }, 'local');
      } else {
        const who = m.route.auth ? await resolveUid(auth, headers) : {};
        const fn = who.deny ? undefined : await load(m.route);
        result =
          who.deny ??
          (fn
            ? await fn(toEvent({ method, url, headers, body }, m, who.uid))
            : problem(
                { title: 'Not implemented', status: 501, detail: `${m.route.handler} has not landed yet` },
                'local',
              ));
      }
      res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>);
      res.end(result.body ?? '');
    })();
  });
}

/** Repositories for the local run: DynamoDB Local when configured (handlers build them from env), else memory. */
export function useLocalRepositories(env: NodeJS.ProcessEnv = process.env): 'dynamodb-local' | 'memory' {
  if (env.CAP_DYNAMODB_ENDPOINT) return 'dynamodb-local';
  setRepositories(createMemoryRepositories());
  return 'memory';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  // The local server defaults to the `local` stage (fake auth); set CAP_STAGE to anything else to use real sessions.
  process.env.CAP_STAGE ??= 'local';
  // Vision answers come from fixtures unless asked otherwise (CAP-39): no Bedrock, no AWS credentials needed.
  process.env.CAP_VISION ??= 'fake';
  const repos = useLocalRepositories();
  const auth = localAuthFor();
  createLocalServer(auth).listen(port, '127.0.0.1', () => {
    console.log(`api:local on http://127.0.0.1:${port} (repositories: ${repos}, auth: ${auth.mode}); routes:`);
    for (const r of ROUTES) {
      const notes = [r.auth ? '' : 'public', hasHandler(r.handler) ? '' : '501'].filter(Boolean).join(', ');
      console.log(`  ${r.method} ${r.path}${notes ? ` (${notes})` : ''}`);
    }
  });
}
