// Typed errors of the API client (CAP-21): screens branch on the class, never on message text.
import type { Problem } from './schema.js';

export class ApiError extends Error {
  override readonly name: string = 'ApiError';
}

/** No API base URL configured (VITE_API_URL empty and no development override). */
export class NotConfiguredError extends ApiError {
  override readonly name = 'NotConfiguredError';
}

/** The request never got an HTTP response (offline, DNS, CORS). */
export class NetworkError extends ApiError {
  override readonly name = 'NetworkError';
}

/** Non-2xx response carrying an RFC 9457 problem body. */
export class ProblemError extends ApiError {
  override readonly name = 'ProblemError';
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
  get status(): number {
    return this.problem.status;
  }
}

/** Non-2xx response without a usable problem body. */
export class HttpError extends ApiError {
  override readonly name = 'HttpError';
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Still unauthorised after one refresh attempt: the session has been cleared (signed out). */
export class UnauthorizedError extends ApiError {
  override readonly name = 'UnauthorizedError';
  readonly status = 401;
}

/** 2xx response whose body does not match the contract schema. */
export class ResponseValidationError extends ApiError {
  override readonly name = 'ResponseValidationError';
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`response of ${path} does not match the contract`);
  }
}
