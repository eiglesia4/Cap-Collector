// Settings "Use AI identification" (CAP-41, openapi `AnalyseRequest.useAi`): on by default; off sends `useAi: false`
// so the API only runs the dHash duplicate check and the capture ends in manual entry (or the exchange path).
import type { KeyValueStore } from '../platform/platform.js';

export const USE_AI_KEY = 'settings.useAi';

export async function readUseAi(store: KeyValueStore): Promise<boolean> {
  return (await store.get(USE_AI_KEY)) !== 'off';
}

export function writeUseAi(store: KeyValueStore, on: boolean): Promise<void> {
  return on ? store.remove(USE_AI_KEY) : store.set(USE_AI_KEY, 'off');
}
