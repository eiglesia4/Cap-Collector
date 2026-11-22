// Docs-only PR detection for the CI `changes` job (CAP-91, 2026-11-22). A PR whose changed files are all Markdown
// skips `test` and `synth` and only gets prettier on those files; anything else runs the full CI.
// Conservative whitelist: every path ends in `.md` and none is `TEST.md`. `TEST.md` is generated from the tests, so
// it always comes with code. `doc/spec/openapi.yaml`, `doc/spec/design/brand/**` and `.claude/**` are read by
// tests or tooling, so they count as code. An empty list counts as code: never skip on a broken diff.
// Runs without dependencies (`node --experimental-strip-types`), so the job needs no `npm ci`:
//   git diff --name-only origin/main...HEAD | node --experimental-strip-types tools/ci/docs-only.ts   → true | false
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Split `git diff --name-only` output into paths (blank lines dropped). */
export function parseFileList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when every changed path is a Markdown file other than the generated `TEST.md`. */
export function isDocsOnly(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => {
    const name = file.split('/').pop() ?? '';
    // A quoted path (git escapes unusual characters as "…") ends in `.md"` and so counts as code.
    return file.endsWith('.md') && name !== 'TEST.md';
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.stdout.write(`${String(isDocsOnly(parseFileList(readFileSync(0, 'utf8'))))}\n`);
}
