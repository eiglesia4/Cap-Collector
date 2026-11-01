// Session store (CAP-21, ADR-008 §4): access/refresh tokens persisted in platform.store (Preferences on iOS,
// localStorage on web), a `signedIn` state screens can subscribe to, and sign-out. Tokens are never logged.
import { SessionSchema, type Session } from '../api/schema.js';
import type { KeyValueStore } from '../platform/platform.js';

export const SESSION_KEY = 'cap.session';

export interface SessionStore {
  /** Read the persisted session; a corrupt or invalid value is discarded. */
  load(): Promise<void>;
  current(): Session | null;
  signedIn(): boolean;
  save(session: Session): Promise<void>;
  signOut(): Promise<void>;
  /** Called with the new `signedIn` state whenever it changes; returns the unsubscribe function. */
  subscribe(listener: (signedIn: boolean) => void): () => void;
}

export function createSessionStore(store: KeyValueStore): SessionStore {
  let session: Session | null = null;
  const listeners = new Set<(signedIn: boolean) => void>();

  function set(next: Session | null): void {
    const was = session !== null;
    session = next;
    if (was !== (next !== null)) for (const listener of listeners) listener(next !== null);
  }

  return {
    async load() {
      const raw = await store.get(SESSION_KEY);
      if (raw === null) return set(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const result = SessionSchema.safeParse(parsed);
      if (result.success) return set(result.data);
      await store.remove(SESSION_KEY);
      set(null);
    },
    current: () => session,
    signedIn: () => session !== null,
    async save(next) {
      await store.set(SESSION_KEY, JSON.stringify(next));
      set(next);
    },
    async signOut() {
      await store.remove(SESSION_KEY);
      set(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
