/**
 * Placeholder Lambda for routes whose handler file is not in api/src/handlers/ yet (CAP-15). Answers 501 with an
 * RFC 9457 problem body, so the route exists (and sits behind the authorizer) before dev-api merges its handler.
 * Bundled by CollectorsApi only while the real handler is missing; it never reads the request.
 */
export interface StubResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const handler = async (): Promise<StubResult> =>
  Promise.resolve({
    statusCode: 501,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      type: 'about:blank',
      title: 'Not Implemented',
      status: 501,
      detail: 'This route is declared in openapi.yaml but its handler is not deployed yet.',
    }),
  });
