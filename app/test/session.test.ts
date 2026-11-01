// Tests for the session store (CAP-21, ADR-008 §4).
import { describe, expect, it, vi } from 'vitest';

import { createSessionStore, SESSION_KEY } from '../src/session/session-store';
import { memoryStore } from './support/fakes';

const SESSION = { accessToken: 'a', refreshToken: 'r', expiresAt: '2026-11-01T22:00:00Z' };

describe('session store', () => {
  it('[T-app-011] persists the session in platform.store, restores it, discards corrupt values and notifies sign-in changes', async () => {
    const store = memoryStore();
    const session = createSessionStore(store);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    await session.load();
    expect(session.signedIn()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    await session.save(SESSION);
    expect(session.current()).toEqual(SESSION);
    expect(listener).toHaveBeenLastCalledWith(true);
    await session.save({ ...SESSION, accessToken: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);

    const restored = createSessionStore(store);
    await restored.load();
    expect(restored.current()).toEqual({ ...SESSION, accessToken: 'b' });

    await session.signOut();
    expect(session.signedIn()).toBe(false);
    expect(store.data.has(SESSION_KEY)).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    await session.save(SESSION);
    expect(listener).toHaveBeenCalledTimes(2);

    for (const corrupt of ['{not json', JSON.stringify({ accessToken: 'only' })]) {
      const s = memoryStore({ [SESSION_KEY]: corrupt });
      const fresh = createSessionStore(s);
      await fresh.load();
      expect(fresh.signedIn()).toBe(false);
      expect(s.data.has(SESSION_KEY)).toBe(false);
    }
  });
});
