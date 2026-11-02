// Server clock: one place that turns "now" into the ISO instants stored in records and `HIST#<ts>` keys (ADR-006).

/** Current instant as ISO 8601 UTC with milliseconds; `clock` is injectable for tests. */
export function now(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

/**
 * An instant strictly after `prev` (and not before the clock): consecutive writes of one record get increasing
 * `updatedAt` and unique `HIST#<ts>` keys even within the same millisecond (ADR-006).
 */
export function after(prev: string, clock: () => number = Date.now): string {
  return new Date(Math.max(clock(), Date.parse(prev) + 1)).toISOString();
}
