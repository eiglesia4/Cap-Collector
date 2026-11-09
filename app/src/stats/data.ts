// The caps behind the Stats tab (CAP-58): every live cap, fetched once per app instance and kept in memory until a
// refresh (button, or pull-to-refresh on the iPhone). Keyed by the API client like the Collection state (CAP-23), so
// tests and app instances never share it.
import type { Cap } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { fetchAllCaps } from '../collection/all-caps.js';

const cache = new WeakMap<object, Promise<Cap[]>>();

/** The cached caps, fetched on first use or when `refresh` is set; a failed fetch is not kept. */
export function statsCaps(api: Pick<ApiClient, 'request'>, refresh = false): Promise<Cap[]> {
  const cached = cache.get(api);
  if (cached && !refresh) return cached;
  const loading = Promise.resolve()
    .then(() => fetchAllCaps(api))
    .catch((error: unknown) => {
      cache.delete(api);
      throw error;
    });
  cache.set(api, loading);
  return loading;
}
