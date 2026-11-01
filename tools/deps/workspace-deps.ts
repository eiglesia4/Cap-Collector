// Workspace dependency hygiene (CAP-14): every declared dependency is installed, and workspaces only share code
// through `@capcollector/shared` (OWNERSHIP.md: one owner per territory, contracts are the only bridge).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The only package a workspace may take from another workspace. */
export const SHARED_PACKAGE = '@capcollector/shared';
const WORKSPACE_SCOPE = '@capcollector/';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', 'coverage', 'ios', 'android']);

interface Manifest {
  readonly name?: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;

/** Workspace directories declared in the root package.json, as absolute paths. */
export function workspaceDirs(root: string): string[] {
  return (readManifest(root).workspaces ?? []).map((ws) => resolve(root, ws));
}

/** Node's lookup: walk up from `fromDir` until `node_modules/<name>/package.json` exists. */
export function isInstalled(name: string, fromDir: string): boolean {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Declared dependencies (runtime + dev) of one workspace that are not installed. */
export function missingDependencies(wsDir: string): string[] {
  const m = readManifest(wsDir);
  const names = [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})];
  return names.filter((n) => !isInstalled(n, wsDir));
}

/** Manifest-level violations: a dependency on any workspace package other than shared. */
export function crossWorkspaceDependencies(wsDir: string): string[] {
  const m = readManifest(wsDir);
  const names = [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})];
  return names.filter((n) => n.startsWith(WORKSPACE_SCOPE) && n !== SHARED_PACKAGE && n !== m.name);
}

const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Import specifiers in one source text (static, side-effect and dynamic imports). */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? '');
}

/**
 * Why an import from `file` (inside `wsDir`) reaches another workspace's internals, or undefined if it is fine:
 * a relative path out of the workspace, another `@capcollector/*` package, or a deep import into shared.
 */
export function internalsViolation(specifier: string, file: string, wsDir: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = relative(wsDir, resolve(dirname(file), specifier));
    return target === '..' || target.startsWith(`..${sep}`) ? 'relative import leaves the workspace' : undefined;
  }
  if (!specifier.startsWith(WORKSPACE_SCOPE)) return undefined;
  if (specifier === SHARED_PACKAGE) return undefined;
  return specifier.startsWith(`${SHARED_PACKAGE}/`)
    ? 'deep import into shared (use the package root)'
    : 'imports another workspace (only shared is allowed)';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : sourceFiles(join(dir, e.name));
    return /\.(?:ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : [];
  });
}

/** Every import in a workspace's sources that reaches into another workspace, as `file: specifier (why)`. */
export function sourceViolations(wsDir: string): string[] {
  return sourceFiles(wsDir).flatMap((file) =>
    importSpecifiers(readFileSync(file, 'utf8')).flatMap((spec) => {
      const why = internalsViolation(spec, file, wsDir);
      return why ? [`${relative(wsDir, file)}: ${spec} (${why})`] : [];
    }),
  );
}
