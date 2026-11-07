// Storage keys of refresh tokens (CAP-19): `USER#<uid>` / `REFRESH#<sha256>`, built only with the shared key builders
// (shared/src/keys.ts `refreshSk`, contracts v0.2, CAP-30).
import { refreshSk, userPk } from '@capcollector/shared';

export const refreshKey = (uid: string, tokenHash: string) => ({ pk: userPk(uid), sk: refreshSk(tokenHash) });

/** Refresh tokens live 90 days (TTL attribute `ttl`, epoch seconds), and are rotated on every use. */
export const REFRESH_TTL_SECONDS = 90 * 24 * 3600;
