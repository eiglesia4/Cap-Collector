// HTTP API Lambda authorizer, simple responses (CAP-19, CAP-15 wiring): validates the session JWT of the
// `Authorization: Bearer …` header and hands the uid to the route as `requestContext.authorizer.lambda.uid`
// (AUTHORIZER_UID_KEY, read by defineHandler). Never throws — a throw would surface as a 500 — and never logs the
// header. API Gateway answers 401 itself when the header is missing and 403 when this returns isAuthorized: false.
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';

import { AUTHORIZER_UID_KEY } from '../lib/http.js';
import { sessionSecret } from './config.js';
import { verifyAccessToken } from './session.js';

export type AuthorizerResult =
  { isAuthorized: true; context: { [AUTHORIZER_UID_KEY]: string } } | { isAuthorized: false };

let secret: Uint8Array | undefined;

export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header?.trim() ?? '');
  return m?.[1];
}

export async function handler(event: Pick<APIGatewayRequestAuthorizerEventV2, 'headers'>): Promise<AuthorizerResult> {
  try {
    secret ??= sessionSecret();
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', event: 'auth.authorizer.config', message: (e as Error).message }));
    return { isAuthorized: false };
  }
  const headers = event.headers ?? {};
  const token = bearerToken(headers.authorization ?? headers.Authorization);
  const uid = token ? await verifyAccessToken(token, secret) : undefined;
  return uid ? { isAuthorized: true, context: { [AUTHORIZER_UID_KEY]: uid } } : { isAuthorized: false };
}

/** Test seam: forget the cached secret. */
export function resetAuthorizer(): void {
  secret = undefined;
}
