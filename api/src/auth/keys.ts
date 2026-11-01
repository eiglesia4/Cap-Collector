// Storage keys of refresh tokens (CAP-19). SPEC-GAP CAP-19: `REFRESH#<hash>` under `USER#<uid>` is not in
// data-model.md / shared keys.ts yet; the architect adds it on acceptance and this file then re-exports it.
import { userPk } from '@capcollector/shared';

export const REFRESH_SK_PREFIX = 'REFRESH#';

export const refreshKey = (uid: string, tokenHash: string) => ({
  pk: userPk(uid),
  sk: `${REFRESH_SK_PREFIX}${tokenHash}`,
});

/** Refresh tokens live 90 days (TTL attribute `ttl`, epoch seconds), and are rotated on every use. */
export const REFRESH_TTL_SECONDS = 90 * 24 * 3600;
