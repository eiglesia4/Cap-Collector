// Tests for the repo wiring (npm test covers every workspace) and the TEST.md catalog (CAP-11).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROJECTS } from '../../vitest.config.js';
import { buildCatalog, idsInTestMd, renderTestMd } from './catalog-lib.js';

const root = resolve(import.meta.dirname, '..', '..');
const fake = (name: string, file = 'api/test/a.test.ts', projectName = 'api') => ({
  name,
  file: join(root, file),
  projectName,
});

describe('test wiring and catalog', () => {
  it('[T-infra-001] npm test runs all workspaces and the catalog lists every test ID exactly once', () => {
    // Every npm workspace is a vitest project with its own config, so the root `vitest run` covers it.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.workspaces.length).toBeGreaterThan(0);
    for (const ws of pkg.workspaces) {
      expect(PROJECTS).toContain(ws);
      expect(existsSync(join(root, ws, 'vitest.config.ts'))).toBe(true);
    }
    expect(pkg.scripts.test).toMatch(/^vitest run/);

    // The committed TEST.md lists each ID exactly once.
    const ids = idsInTestMd(readFileSync(join(root, 'TEST.md'), 'utf8'));
    expect(ids).toContain('T-infra-001');
    expect(new Set(ids).size).toBe(ids.length);

    // The generator keeps one row per ID, sorted numerically.
    const { entries, errors } = buildCatalog(
      [fake('b > [T-api-010] ten'), fake('a > [T-api-002] two'), fake('[T-app-001] one', 'app/test/x.test.ts', 'app')],
      root,
    );
    expect(errors).toEqual([]);
    expect(idsInTestMd(renderTestMd(entries))).toEqual(['T-api-002', 'T-api-010', 'T-app-001']);
  });

  it('[T-infra-006] the catalog rejects missing IDs, unknown components and reused IDs', () => {
    const { entries, errors } = buildCatalog(
      [
        fake('[T-api-001] first'),
        fake('[T-api-001] again', 'api/test/b.test.ts'),
        fake('no id here'),
        fake('[T-web-001] wrong component'),
      ],
      root,
    );
    expect(entries.map((e) => e.id)).toEqual(['T-api-001']);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/T-api-001 used twice: api\/test\/a\.test\.ts and api\/test\/b\.test\.ts/);
    expect(errors.join('\n')).toMatch(/without \[T-<comp>-nnn\] ID/);
    expect(errors.join('\n')).toMatch(/unknown component "web"/);
  });

  it('[T-infra-007] rendered TEST.md escapes pipes and uses repo-relative paths', () => {
    const { entries } = buildCatalog([fake('[T-api-003] a | b')], root);
    const md = renderTestMd(entries);
    expect(md).toContain('| T-api-003 | a \\| b | api | `api/test/a.test.ts` |');
    expect(md).not.toContain(root);
  });
});
