// Batch capture state shared by the Scan tab and the batch screens (CAP-83; ADR-009): the tray photo, handed from
// Scan to Tray adjust in memory only (never stored or uploaded, ADR-009 §2), and the on-device batch queue.
import type { BatchStore } from './store.js';

/** The tray photo between the shot and Start, in memory. */
export interface TrayHolder {
  current(): Blob | null;
  set(photo: Blob): void;
  clear(): void;
}

export interface BatchContext {
  readonly tray: TrayHolder;
  readonly store: BatchStore;
}

export function createTrayHolder(): TrayHolder {
  let photo: Blob | null = null;
  return {
    current: () => photo,
    set: (next) => {
      photo = next;
    },
    clear: () => {
      photo = null;
    },
  };
}

export function createBatchContext(store: BatchStore): BatchContext {
  return { tray: createTrayHolder(), store };
}

/** Store key of the Scan tab's Single · Batch switch (remembered per device). */
export const SCAN_MODE_KEY = 'scan.mode';
export type ScanMode = 'single' | 'batch';

export function parseScanMode(value: string | null): ScanMode {
  return value === 'batch' ? 'batch' : 'single';
}
