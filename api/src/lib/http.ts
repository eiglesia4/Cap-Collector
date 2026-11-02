// Handler wrapper every route uses (CLAUDE.md § api: "un handler por ruta, lógica en lib/"): parses and validates
// body/query/path with the zod contracts of @capcollector/shared, injects the caller's `uid` from the Lambda authorizer
// context, and turns errors into RFC 9457 Problems (openapi.yaml § Problem). Never logs bodies, headers or tokens.
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { ZodError, type z } from 'zod';

import { ApiError, BadRequest, Unauthorized } from './errors.js';
import { newId } from './ids.js';

/**
 * Key of the caller's id in the Lambda authorizer context (`requestContext.authorizer.lambda.uid`).
 * The authorizer (CAP-19) must return `{ isAuthorized, context: { uid } }` with this key.
 */
export const AUTHORIZER_UID_KEY = 'uid';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;
const PROBLEM_HEADERS = { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } as const;

export interface ProblemBody {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

export interface HandlerSpec<
  B extends z.ZodType | undefined,
  Q extends z.ZodType | undefined,
  P extends z.ZodType | undefined,
  A extends boolean,
> {
  body?: B;
  query?: Q;
  path?: P;
  auth: A;
}

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface Request<B, Q, P, A extends boolean> {
  body: B;
  /** The JSON body before zod (defaults not applied): which keys the client actually sent (CAP-18 PATCH). */
  rawBody: unknown;
  query: Q;
  path: P;
  /** Caller id (Apple `sub`, data-model.md); always set when `auth: true`. */
  uid: A extends true ? string : string | undefined;
  requestId: string;
  event: APIGatewayProxyEventV2;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const noContent = (): Reply => ({ status: 204 });

/** The handler shape Lambda calls; also callable directly from tests and the local server. */
export type Handler = ((
  event: APIGatewayProxyEventV2,
  context?: Context,
) => Promise<APIGatewayProxyStructuredResultV2>) &
  APIGatewayProxyHandlerV2;

export function problem(p: ProblemBody, requestId: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode: p.status, headers: { ...PROBLEM_HEADERS, 'x-request-id': requestId }, body: JSON.stringify(p) };
}

function zodProblem(err: ZodError, where: string): ProblemBody {
  return {
    title: 'Validation failed',
    status: 422,
    detail: `Invalid ${where}`,
    errors: err.issues.map((i) => ({ path: [where, ...i.path.map(String)].join('.'), message: i.message })),
  };
}

function readBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body === '') return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest('Request body is not valid JSON');
  }
}

/** Reads the uid placed by the Lambda authorizer; `undefined` when the route is public or the context is missing. */
export function authorizerUid(event: APIGatewayProxyEventV2): string | undefined {
  const ctx = (event.requestContext as { authorizer?: { lambda?: Record<string, unknown> } }).authorizer;
  const uid = ctx?.lambda?.[AUTHORIZER_UID_KEY];
  return typeof uid === 'string' && uid.length > 0 ? uid : undefined;
}

function validate<S extends z.ZodType | undefined>(schema: S, value: unknown, where: string): Parsed<S> {
  if (!schema) return undefined as Parsed<S>;
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(r.error, where);
  return r.data as Parsed<S>;
}

/** Throw to answer 422 for a schema checked inside a handler (e.g. the merged record), reported under `where`. */
export class ValidationError extends Error {
  constructor(
    readonly zod: ZodError,
    readonly where: string,
  ) {
    super(`invalid ${where}`);
  }
}

function toProblem(err: unknown, requestId: string, routeKey: string): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ValidationError) return problem(zodProblem(err.zod, err.where), requestId);
  if (err instanceof ZodError) return problem(zodProblem(err, 'data'), requestId);
  if (err instanceof ApiError) {
    return problem(
      { title: err.title, status: err.status, ...(err.message ? { detail: err.message } : {}) },
      requestId,
    );
  }
  // Unknown: log name + message + stack only (no event, no body), answer without leaking internals.
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(
    JSON.stringify({ level: 'error', requestId, routeKey, error: e.name, message: e.message, stack: e.stack }),
  );
  return problem(
    { title: 'Internal error', status: 500, detail: `Unexpected error; request id ${requestId}` },
    requestId,
  );
}

/**
 * Wraps a route function: validates inputs, enforces auth, serialises the reply as uncached JSON and maps errors
 * (ZodError → 422 with `errors[]`, ApiError → its status, anything else → 500 with the request id).
 */
export function defineHandler<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
  A extends boolean = boolean,
>(spec: HandlerSpec<B, Q, P, A>, fn: (req: Request<Parsed<B>, Parsed<Q>, Parsed<P>, A>) => Promise<Reply>): Handler {
  const handler = async (event: APIGatewayProxyEventV2, context?: Context) => {
    const requestId = event.requestContext?.requestId || context?.awsRequestId || newId();
    try {
      const uid = authorizerUid(event);
      if (spec.auth && !uid) throw new Unauthorized('Missing or invalid credentials');
      const rawBody = spec.body ? readBody(event) : undefined;
      const req = {
        body: validate(spec.body, rawBody, 'body'),
        rawBody,
        query: validate(spec.query, event.queryStringParameters ?? {}, 'query'),
        path: validate(spec.path, event.pathParameters ?? {}, 'path'),
        uid,
        requestId,
        event,
      } as Request<Parsed<B>, Parsed<Q>, Parsed<P>, A>;
      const reply = await fn(req);
      return {
        statusCode: reply.status,
        headers: { ...JSON_HEADERS, 'x-request-id': requestId, ...reply.headers },
        ...(reply.body === undefined ? {} : { body: JSON.stringify(reply.body) }),
      };
    } catch (err) {
      return toProblem(err, requestId, event.routeKey);
    }
  };
  return handler as Handler;
}
