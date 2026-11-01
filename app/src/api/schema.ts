// Response validation for the API client (CAP-21): responses are parsed, never cast. `Schema<T>` is the
// structural subset of a zod schema, so every `@capcollector/shared` schema can be passed as-is.
//
// SPEC-GAP CAP-21: openapi.yaml defines `Problem`, `Session` and the `/healthz` body, but `@capcollector/shared`
// 0.1.0 has no zod schemas for them, and app/ has no direct `zod` dependency. They are validated here by hand,
// exactly as openapi.yaml § components.schemas describes them; to be replaced by the shared schemas once the
// architect publishes them.

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

export interface Schema<T> {
  safeParse(data: unknown): SafeParseResult<T>;
}

type Check<T> = (value: unknown) => T | string;

function schema<T>(check: Check<T>): Schema<T> {
  return {
    safeParse(data) {
      const result = check(data);
      return typeof result === 'string'
        ? { success: false, error: new Error(result) }
        : { success: true, data: result };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 9457 problem details (openapi.yaml § Problem). */
export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path?: string; message?: string }[];
}

export const ProblemSchema = schema<Problem>((v) => {
  if (!isRecord(v)) return 'problem: not an object';
  if (typeof v.title !== 'string') return 'problem: title must be a string';
  if (typeof v.status !== 'number' || !Number.isInteger(v.status)) return 'problem: status must be an integer';
  const problem: Problem = { title: v.title, status: v.status };
  if (v.type !== undefined) {
    if (typeof v.type !== 'string') return 'problem: type must be a string';
    problem.type = v.type;
  }
  if (v.detail !== undefined) {
    if (typeof v.detail !== 'string') return 'problem: detail must be a string';
    problem.detail = v.detail;
  }
  if (v.errors !== undefined) {
    if (!Array.isArray(v.errors)) return 'problem: errors must be an array';
    const errors: { path?: string; message?: string }[] = [];
    for (const e of v.errors) {
      if (!isRecord(e)) return 'problem: errors[] must be objects';
      const item: { path?: string; message?: string } = {};
      if (typeof e.path === 'string') item.path = e.path;
      if (typeof e.message === 'string') item.message = e.message;
      errors.push(item);
    }
    problem.errors = errors;
  }
  return problem;
});

/** Session issued by `/auth/apple` and `/auth/refresh` (openapi.yaml § Session). */
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export const SessionSchema = schema<Session>((v) => {
  if (!isRecord(v)) return 'session: not an object';
  const { accessToken, refreshToken, expiresAt } = v;
  if (typeof accessToken !== 'string' || accessToken === '') return 'session: accessToken required';
  if (typeof refreshToken !== 'string' || refreshToken === '') return 'session: refreshToken required';
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    return 'session: expiresAt must be a date-time';
  return { accessToken, refreshToken, expiresAt };
});

/** `GET /healthz` body (openapi.yaml § /healthz). */
export interface Healthz {
  status: 'ok';
}

export const HealthzSchema = schema<Healthz>((v) =>
  isRecord(v) && v.status === 'ok' ? { status: 'ok' } : 'healthz: status must be "ok"',
);
