// Server clock: one place that turns "now" into the ISO instants stored in records and `HIST#<ts>` keys (ADR-006).

/** Current instant as ISO 8601 UTC with milliseconds; `clock` is injectable for tests. */
export function now(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
