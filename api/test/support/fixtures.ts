// Test fixtures for api/ (CAP-17): the Mahou cap of shared/test/fixtures/cap.json (copied, not imported — workspaces
// share only the package root) plus builders for caps, history entries and API Gateway v2 events.
import { randomUUID } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Cap, type CapHistory, CapHistory as CapHistorySchema, type Location } from '@capcollector/shared';

import { newId } from '../../src/lib/ids.js';

export const FIXTURE_CAP: Cap = Cap.parse({
  capId: '01JBF6Z3Q8K2M4N6P8R0S2T4V6',
  status: 'complete',
  images: {
    top: { key: 'u1/01JBF6Z3Q8K2M4N6P8R0S2T4V6/top.webp', width: 1024, height: 1024, bytes: 182044 },
    underside: { key: 'u1/01JBF6Z3Q8K2M4N6P8R0S2T4V6/underside.webp', width: 1024, height: 1024 },
  },
  createdAt: '2023-03-14T18:22:10.000Z',
  updatedAt: '2026-10-12T09:15:00.000+02:00',
  brand: 'Mahou',
  variant: 'Clásica',
  producer: 'Mahou San Miguel',
  country: 'ES',
  type: 'beer',
  material: 'steel',
  closure: 'pry-off',
  year: 2023,
  textOnCap: 'MAHOU',
  condition: 'mint',
  tags: ['spain', 'lager'],
  quantity: 3,
  forTrade: 2,
  location: { kind: 'album', album: 'A', sheet: 3, pocket: 17 },
  source: 'bedrock:anthropic.claude-haiku',
  dhash: 'a3f0c81e7b2d9f44',
  aiModel: 'anthropic.claude-haiku',
  aiConfidence: 0.92,
});

let tick = Date.parse('2026-11-01T10:00:00.000Z');
/** Strictly increasing instants so `HIST#<ts>` keys never collide inside a test run. */
export const nextTs = () => new Date((tick += 7)).toISOString();

export function makeCap(over: Partial<Cap> & { location?: Location | undefined } = {}): Cap {
  const ts = nextTs();
  const { location, ...rest } = over;
  const base: Cap = { ...FIXTURE_CAP, capId: newId(), createdAt: ts, updatedAt: ts, ...rest };
  if ('location' in over) {
    delete base.location;
    if (location) base.location = location;
  }
  return Cap.parse(base);
}

export function makeHistory(capId: string, action: CapHistory['action'], ts = nextTs()): CapHistory {
  return CapHistorySchema.parse({ capId, ts, source: 'manual', action, changes: [] });
}

export const pocket = (sheet: number, pocketNo: number, album = 'A'): Location => ({
  kind: 'album',
  album,
  sheet,
  pocket: pocketNo,
});

export function apiEvent(over: Partial<APIGatewayProxyEventV2> & { uid?: string } = {}): APIGatewayProxyEventV2 {
  const { uid, ...rest } = over;
  return {
    version: '2.0',
    routeKey: 'GET /test',
    rawPath: '/test',
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      requestId: `req-${randomUUID()}`,
      ...(uid ? { authorizer: { lambda: { uid } } } : {}),
    } as APIGatewayProxyEventV2['requestContext'],
    ...rest,
  };
}

/** A fresh, unique test user/brand/album so suites can share one DynamoDB Local table. */
export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
