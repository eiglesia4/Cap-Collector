// Coverage badge for the README (CAP-103, 2026-11-23): turns vitest's `coverage/coverage-summary.json` into a
// shields.io endpoint JSON, which the CI `coverage-badge` job commits to the orphan `badges` branch after every push to
// `main`. No third-party service and no token beyond the workflow's own GITHUB_TOKEN.
// Runs without dependencies (`node --experimental-strip-types`), so the job needs no `npm ci`:
//   node --experimental-strip-types tools/ci/coverage-badge.ts coverage/coverage-summary.json > coverage.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** shields.io endpoint schema (https://shields.io/badges/endpoint-badge). */
export interface EndpointBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/** Badge colour from the lower of the two percentages. 80 is the repo's coverage gate (vitest.config.ts). */
export function badgeColor(pct: number): string {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 80) return 'green';
  if (pct >= 70) return 'yellow';
  if (pct >= 60) return 'orange';
  return 'red';
}

function totalPct(summary: unknown, metric: 'lines' | 'branches'): number {
  const total = (summary as { total?: Record<string, { pct?: unknown } | undefined> } | null)?.total;
  const pct = total?.[metric]?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`coverage-summary.json has no valid total.${metric}.pct`);
  }
  return pct;
}

/**
 * Endpoint JSON for the README badge: "97% lines · 89% branches". Percentages are floored, so the badge never
 * shows more than was measured. Throws on a summary without valid totals: the job fails rather than publish junk.
 */
export function coverageBadge(summary: unknown): EndpointBadge {
  const lines = Math.floor(totalPct(summary, 'lines'));
  const branches = Math.floor(totalPct(summary, 'branches'));
  return {
    schemaVersion: 1,
    label: 'coverage',
    message: `${String(lines)}% lines · ${String(branches)}% branches`,
    color: badgeColor(Math.min(lines, branches)),
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const file = process.argv[2] ?? 'coverage/coverage-summary.json';
  process.stdout.write(`${JSON.stringify(coverageBadge(JSON.parse(readFileSync(file, 'utf8'))))}\n`);
}
