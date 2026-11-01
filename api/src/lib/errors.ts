// Domain errors thrown by api/src/lib and handlers; `defineHandler` (http.ts) maps each one to an RFC 9457 Problem
// (openapi.yaml § components.schemas.Problem). Kept apart from http.ts so repositories never import HTTP code.

/** Base class: carries the HTTP status and the Problem `title`. */
export abstract class ApiError extends Error {
  abstract readonly status: number;
  abstract readonly title: string;
}

export class BadRequest extends ApiError {
  readonly status = 400;
  readonly title = 'Bad request';
  override readonly name = 'BadRequest';
}

export class Unauthorized extends ApiError {
  readonly status = 401;
  readonly title = 'Unauthorized';
  override readonly name = 'Unauthorized';
}

export class NotFound extends ApiError {
  readonly status = 404;
  readonly title = 'Not found';
  override readonly name = 'NotFound';
}

/** Optimistic-concurrency or uniqueness failure (stale `updatedAt`, occupied pocket, duplicate id). */
export class Conflict extends ApiError {
  readonly status = 409;
  readonly title = 'Conflict';
  override readonly name = 'Conflict';
}

/** A route or repository method whose story has not landed yet (CAP-17: Dynamo stubs for albums/scans/exchange). */
export class NotImplemented extends ApiError {
  readonly status = 501;
  readonly title = 'Not implemented';
  override readonly name = 'NotImplemented';
}
