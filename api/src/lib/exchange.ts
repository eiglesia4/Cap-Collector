// Exchange requests service (CAP-44): POST/GET /exchange/requests and PATCH /exchange/requests/{requestId} behind thin
// handlers. Spec: ADR-007 (manual exchange with any external AI), exchange.md § Pending requests (`EXCHANGE#<requestId>`,
// waiting | answered | reviewed | expired, 30-day expiry), openapi.yaml /exchange/requests, data-model.md (`ttl` =
// created + 30 d). The zip itself is built on the client; the API only tracks what is still out.
import { DHash, ExchangeRequestItem, ExchangeStatus, Ulid, exchangeTtl } from '@capcollector/shared';
import { z } from 'zod';

import { Conflict, NotFound } from './errors.js';
import { ValidationError } from './http.js';
import type { Repositories } from './repo/types.js';
import { now } from './time.js';

/** POST /exchange/requests body (openapi.yaml: required requestId + dhash; capId/scanId optional). */
export const ExchangeCreateBody = z.object({
  requestId: Ulid,
  dhash: DHash,
  capId: Ulid.optional(),
  scanId: Ulid.optional(),
});
export type ExchangeCreateBody = z.infer<typeof ExchangeCreateBody>;

/** GET /exchange/requests query: optional `status` filter (applied to the status as reported, expiry included). */
export const ExchangeListQuery = z.object({ status: ExchangeStatus.optional() });
export type ExchangeListQuery = z.infer<typeof ExchangeListQuery>;

export const ExchangeRequestIdPath = z.object({ requestId: Ulid });

/** PATCH body (openapi.yaml: `status` required, `provider` free text, e.g. `chatgpt`, `gemini`). */
export const ExchangePatchBody = z.object({ status: ExchangeStatus, provider: z.string().optional() });
export type ExchangePatchBody = z.infer<typeof ExchangePatchBody>;

/** The only moves the lifecycle allows (CAP-44): `reviewed` and `expired` are terminal. */
type Status = z.infer<typeof ExchangeStatus>;
const NEXT: Partial<Record<Status, Status>> = { waiting: 'answered', answered: 'reviewed' };

export interface ExchangeDeps {
  repos: Repositories;
  /** Injectable for tests; epoch milliseconds. */
  clock?: () => number;
}

/**
 * Status as the client sees it: past `ttl` the item is `expired`, whatever it stored. DynamoDB TTL deletion is lazy
 * (up to days), so an item may still be read after its expiry (exchange.md § Pending requests: expire after 30 days).
 */
export function effective(item: ExchangeRequestItem, nowMs: number): ExchangeRequestItem {
  return item.ttl !== undefined && item.ttl <= Math.floor(nowMs / 1000) ? { ...item, status: 'expired' } : item;
}

/** Registers a downloaded bundle as `waiting`; links the scan it came from when that scan exists (best effort). */
export async function createExchangeRequest(
  deps: ExchangeDeps,
  uid: string,
  body: ExchangeCreateBody,
): Promise<ExchangeRequestItem> {
  const clock = deps.clock ?? Date.now;
  const nowMs = clock();
  const item = ExchangeRequestItem.parse({
    requestId: body.requestId,
    createdAt: now(() => nowMs),
    status: 'waiting',
    dhash: body.dhash,
    ...(body.capId ? { capId: body.capId } : {}),
    ...(body.scanId ? { scanId: body.scanId } : {}),
    ttl: exchangeTtl(nowMs),
  });
  if (await deps.repos.exchange.get(uid, item.requestId)) {
    throw new Conflict(`Exchange request ${item.requestId} already exists`);
  }
  // Best effort: an unknown scanId (never stored, or another user's) registers the request without the link.
  const scan = body.scanId ? await deps.repos.scans.get(uid, body.scanId) : undefined;
  await deps.repos.exchange.create(uid, item, scan);
  return item;
}

/** The user's requests, newest first, with expiry applied before the optional status filter. */
export async function listExchangeRequests(
  deps: ExchangeDeps,
  uid: string,
  query: ExchangeListQuery,
): Promise<ExchangeRequestItem[]> {
  const nowMs = (deps.clock ?? Date.now)();
  return (await deps.repos.exchange.list(uid))
    .map((i) => effective(i, nowMs))
    .filter((i) => query.status === undefined || i.status === query.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.requestId.localeCompare(a.requestId));
}

/**
 * `provider` is required for `answered` (CAP-44) and rejected otherwise. SPEC-GAP CAP-44: openapi.yaml only types it as a
 * string; sending it with `reviewed` is refused (422) instead of silently dropped, so the stored provider of the answer
 * can never be overwritten or confused.
 */
function requireProvider(body: ExchangePatchBody): string {
  const provider = body.provider?.trim();
  if (body.status === 'answered' && !provider) {
    const issue = {
      code: 'custom' as const,
      path: ['provider'],
      message: 'provider is required to mark answered',
      input: body.provider,
    };
    throw new ValidationError(new z.ZodError([issue]), 'body');
  }
  if (body.status !== 'answered' && body.provider !== undefined) {
    const issue = {
      code: 'custom' as const,
      path: ['provider'],
      message: 'provider only applies to answered',
      input: body.provider,
    };
    throw new ValidationError(new z.ZodError([issue]), 'body');
  }
  return provider ?? '';
}

/** waiting → answered (with `provider`), answered → reviewed; any other move is 409 naming the current status. */
export async function patchExchangeRequest(
  deps: ExchangeDeps,
  uid: string,
  requestId: string,
  body: ExchangePatchBody,
): Promise<ExchangeRequestItem> {
  const provider = requireProvider(body);
  const nowMs = (deps.clock ?? Date.now)();
  const stored = await deps.repos.exchange.get(uid, requestId);
  if (!stored) throw new NotFound(`Exchange request ${requestId} not found`);
  const current = effective(stored, nowMs).status;
  if (NEXT[current] !== body.status) {
    throw new Conflict(`Exchange request is ${current}; it cannot move to ${body.status}`);
  }
  const next = ExchangeRequestItem.parse({
    ...stored,
    status: body.status,
    ...(body.status === 'answered' ? { provider, answeredAt: now(() => nowMs) } : {}),
  });
  await deps.repos.exchange.update(uid, next, stored.status);
  return next;
}
