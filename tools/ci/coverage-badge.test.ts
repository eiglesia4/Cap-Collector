// Coverage badge for the README (CAP-103): the shields.io endpoint JSON built from coverage-summary.json, and the CLI
// the CI `coverage-badge` job runs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { badgeColor, coverageBadge } from './coverage-badge.js';

const script = resolve(import.meta.dirname, 'coverage-badge.ts');

const summary = (lines: unknown, branches: unknown): unknown => ({
  total: { lines: { pct: lines }, branches: { pct: branches }, functions: { pct: 95 }, statements: { pct: 96 } },
});

describe('coverage badge', () => {
  it('[T-infra-054] builds the endpoint JSON from lines and branches (floored), coloured by the lower one; rejects a summary without valid totals', () => {
    expect(coverageBadge(summary(97.24, 88.61))).toEqual({
      schemaVersion: 1,
      label: 'coverage',
      message: '97% lines · 88% branches',
      color: 'green',
    });
    expect(coverageBadge(summary(100, 90)).color).toBe('brightgreen');
    expect(coverageBadge(summary(79.99, 95)).message).toBe('79% lines · 95% branches');
    expect(coverageBadge(summary(79.99, 95)).color).toBe('yellow');

    expect(badgeColor(90)).toBe('brightgreen');
    expect(badgeColor(80)).toBe('green');
    expect(badgeColor(70)).toBe('yellow');
    expect(badgeColor(60)).toBe('orange');
    expect(badgeColor(59.9)).toBe('red');

    expect(() => coverageBadge({})).toThrow(/total\.lines\.pct/);
    expect(() => coverageBadge(null)).toThrow(/total\.lines\.pct/);
    expect(() => coverageBadge(summary(97, 'Unknown'))).toThrow(/total\.branches\.pct/);
    expect(() => coverageBadge(summary(Number.NaN, 90))).toThrow(/total\.lines\.pct/);
    expect(() => coverageBadge(summary(101, 90))).toThrow(/total\.lines\.pct/);
  });

  it('[T-infra-055] the CLI reads the summary file and prints the endpoint JSON, as the CI job runs it; a bad file fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-badge-'));
    const good = join(dir, 'coverage-summary.json');
    writeFileSync(good, JSON.stringify(summary(97.5, 89.2)));
    const run = (file: string) =>
      spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, file], { encoding: 'utf8' });

    const ok = run(good);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      schemaVersion: 1,
      label: 'coverage',
      message: '97% lines · 89% branches',
      color: 'green',
    });

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"total":{}}');
    const failed = run(bad);
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
  });
});
