// GET /healthz — liveness probe for the API Gateway HTTP API (placeholder route of the V0 skeleton, CAP-11).
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
// Proves the shared contracts package resolves from api/ (it exports nothing yet; EP-01 fills it in).
import '@capcollector/shared';

export interface HealthzBody {
  status: 'ok';
}

export async function handler(): Promise<APIGatewayProxyResultV2> {
  const body: HealthzBody = { status: 'ok' };
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
