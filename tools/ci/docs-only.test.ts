// Docs-only PR detection for the CI `changes` job (CAP-91): the classification rule and the stdin CLI the job runs.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isDocsOnly, parseFileList } from './docs-only.js';

const script = resolve(import.meta.dirname, 'docs-only.ts');

describe('docs-only PR detection', () => {
  it('[T-infra-048] only Markdown other than TEST.md is docs-only; code, spec YAML, brand assets, .claude and an empty diff are not', () => {
    expect(isDocsOnly(['CHANGELOG.md'])).toBe(true);
    expect(isDocsOnly(['doc/spec/decisions/ADR-010-webkit-webp-and-crop-check.md', 'CLAUDE.md'])).toBe(true);
    expect(isDocsOnly(['doc/plans/_PLANTILLA.md', '.claude/commands/next.md'])).toBe(true);

    expect(isDocsOnly([])).toBe(false);
    expect(isDocsOnly(['TEST.md'])).toBe(false);
    expect(isDocsOnly(['CHANGELOG.md', 'TEST.md'])).toBe(false);
    expect(isDocsOnly(['tools/catalog/TEST.md'])).toBe(false);
    expect(isDocsOnly(['doc/spec/README.md', 'doc/spec/openapi.yaml'])).toBe(false);
    expect(isDocsOnly(['doc/spec/design/brand/mark.svg'])).toBe(false);
    expect(isDocsOnly(['.claude/settings.json'])).toBe(false);
    expect(isDocsOnly(['app/src/app.ts', 'CHANGELOG.md'])).toBe(false);
    expect(isDocsOnly(['README.MD'])).toBe(false);
    expect(isDocsOnly(['"doc/caf\\303\\251.md"'])).toBe(false);

    expect(parseFileList('CHANGELOG.md\n\n  doc/plans/x.md  \n')).toEqual(['CHANGELOG.md', 'doc/plans/x.md']);
    expect(parseFileList('')).toEqual([]);
  });

  it('[T-infra-049] the CLI reads git diff --name-only from stdin and prints true or false, as the CI job runs it', () => {
    const run = (input: string): string => {
      const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script], {
        input,
        encoding: 'utf8',
      });
      expect(out.status).toBe(0);
      return out.stdout.trim();
    };
    expect(run('CHANGELOG.md\ndoc/spec/design/SCREENS.md\n')).toBe('true');
    expect(run('CHANGELOG.md\ndoc/spec/openapi.yaml\n')).toBe('false');
    expect(run('')).toBe('false');
  });
});
