// Workspace dependency hygiene (CAP-14): declared deps resolve, and workspaces only share code through shared.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  crossWorkspaceDependencies,
  importSpecifiers,
  internalsViolation,
  isInstalled,
  missingDependencies,
  sourceViolations,
  workspaceDirs,
} from './workspace-deps.js';

const root = resolve(import.meta.dirname, '..', '..');

describe('workspace dependencies', () => {
  it('[T-infra-015] every declared dependency resolves and no workspace depends on another one but shared', () => {
    // The real repo: all four workspaces are clean.
    const dirs = workspaceDirs(root);
    expect(dirs.map((d) => basename(d))).toEqual(['shared', 'app', 'api', 'infra']);
    for (const dir of dirs) {
      expect({ ws: basename(dir), missing: missingDependencies(dir) }).toEqual({ ws: basename(dir), missing: [] });
      expect(crossWorkspaceDependencies(dir)).toEqual([]);
      expect(sourceViolations(dir)).toEqual([]);
    }

    // The checker catches what it is meant to catch.
    const tmp = mkdtempSync(join(tmpdir(), 'cap-deps-'));
    const ws = join(tmp, 'api');
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(tmp, 'node_modules', 'present'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'present', 'package.json'), '{}');
    writeFileSync(
      join(ws, 'package.json'),
      JSON.stringify({
        name: '@capcollector/api',
        dependencies: { present: '^1.0.0', '@capcollector/shared': '0.0.0', '@capcollector/app': '0.0.0' },
        devDependencies: { 'not-installed': '^1.0.0' },
      }),
    );
    writeFileSync(
      join(ws, 'src', 'h.ts'),
      [
        "import { a } from './ok.js';",
        "import { b } from '../../app/src/x.js';",
        "import { c } from '@capcollector/shared';",
        "import { d } from '@capcollector/shared/src/keys.js';",
        "const e = await import('@capcollector/app');",
        "import 'zod';",
      ].join('\n'),
    );
    expect(isInstalled('present', ws)).toBe(true);
    expect(missingDependencies(ws)).toEqual(['@capcollector/shared', '@capcollector/app', 'not-installed']);
    expect(crossWorkspaceDependencies(ws)).toEqual(['@capcollector/app']);
    expect(sourceViolations(ws)).toEqual([
      'src/h.ts: ../../app/src/x.js (relative import leaves the workspace)',
      'src/h.ts: @capcollector/shared/src/keys.js (deep import into shared (use the package root))',
      'src/h.ts: @capcollector/app (imports another workspace (only shared is allowed))',
    ]);
    expect(importSpecifiers("export { x } from './y.js';")).toEqual(['./y.js']);
    expect(internalsViolation('..', join(ws, 'src', 'h.ts'), ws)).toBeUndefined();
    expect(workspaceDirs(ws)).toEqual([]);
  });
});
