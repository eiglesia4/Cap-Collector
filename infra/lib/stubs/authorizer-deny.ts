/**
 * Stand-in HTTP API Lambda authorizer (simple response) until dev-api merges api/src/auth/authorizer.ts (CAP-19).
 * Denies every request: no protected route is reachable through a stub. CollectorsApi bundles the real authorizer
 * as soon as that file exists, so this stub is never deployed next to it.
 */
export const handler = async (): Promise<{ readonly isAuthorized: false }> => Promise.resolve({ isAuthorized: false });
