// `npm run api:local` (CAP-17): a plain Node http server that turns requests into API Gateway HTTP API v2 events and
// runs the Lambda handlers of src/routes.ts in-process. Repositories: in memory, or DynamoDB Local when
// CAP_DYNAMODB_ENDPOINT is set (deploy/docker-compose.yaml + `npm run db:create`). Auth is faked: the `x-cap-uid`
// header (default CAP_LOCAL_UID or "local-user") stands in for the Lambda authorizer context. Never deployed.
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { AUTHORIZER_UID_KEY, problem } from '../src/lib/http.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { ROUTES, type RouteDef } from '../src/routes.js';

export const LOCAL_UID_HEADER = 'x-cap-uid';

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

export function createLocalServer(defaultUid: string | undefined = process.env.CAP_LOCAL_UID || 'local-user'): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      const m = matchRoute(method, url.pathname);
      const result = m
        ? await (
            await m.route.load()
          )(
            toEvent(
              {
                method,
                url,
                headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
                body: await readBody(req),
              },
              m,
              (req.headers[LOCAL_UID_HEADER] as string | undefined) ?? defaultUid,
            ),
          )
        : problem({ title: 'Not found', status: 404, detail: `No route ${method} ${url.pathname}` }, 'local');
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
  const repos = useLocalRepositories();
  createLocalServer().listen(port, '127.0.0.1', () => {
    console.log(`api:local on http://127.0.0.1:${port} (repositories: ${repos}); routes:`);
    for (const r of ROUTES) console.log(`  ${r.method} ${r.path}${r.auth ? '' : ' (public)'}`);
  });
}
