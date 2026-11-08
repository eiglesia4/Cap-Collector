// Capture flow of the Scan tab (CAP-41; SCREENS.md #2 and § Navigation; ADR-003 three outcomes; ADR-004 hash first):
// top photo → circular crop + dHash (CAP-36) → optional underside ("Add underside?", skippable) → upload both
// (CAP-25 `upload.ts`) → `POST /scans/analyse` → the route of the outcome. A 503 (AI unavailable) stops in its own
// state so the screen offers Enter manually · Export for external AI · Retry. Pure orchestration over injected
// effects, so every transition is testable without a canvas, a camera or the network.
import type { AnalyseRequest, AnalyseResponse, ImageRef } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import type { CapPhoto } from '../images/resize.js';
import type { Side } from '../images/upload.js';
import type { CaptureSession, CaptureStore } from './context.js';

/** Where each outcome continues (SCREENS.md #3/#4/#5; CAP-42, CAP-43, CAP-25). */
export const OUTCOME_PATHS = {
  duplicate: '/scan/duplicate',
  identified: '/scan/review',
} as const;

/** Manual entry of this scan: the empty form with its photos and the AI's brand suggestions. */
export function manualEntryPath(scanId: string): string {
  return `/new?scanId=${encodeURIComponent(scanId)}`;
}

export function routeFor(response: AnalyseResponse): string {
  return response.outcome === 'unidentified' ? manualEntryPath(response.scanId) : OUTCOME_PATHS[response.outcome];
}

/** Why a step failed: `photo` = the picked file is unusable (retake); the others can be retried as they are. */
export type FailureKind = 'photo' | 'upload' | 'analyse';

export type CaptureState =
  | { readonly step: 'idle' }
  | { readonly step: 'preparing'; readonly side: Side }
  /** The top photo is ready: ask for the underside (skippable). */
  | { readonly step: 'underside' }
  | { readonly step: 'uploading' }
  | { readonly step: 'analysing' }
  /** `POST /scans/analyse` answered 503: manual entry, external AI (soon) or retry. */
  | { readonly step: 'aiUnavailable' }
  | { readonly step: 'failed'; readonly kind: FailureKind; readonly side?: Side }
  | { readonly step: 'done'; readonly path: string };

export interface CaptureDeps {
  readonly store: CaptureStore;
  /** Circular crop, ≤ 1024 px WebP and dHash (`resizeToWebp(file, { crop: 'circle' })`). */
  prepare(file: Blob): Promise<CapPhoto>;
  upload(side: Side, photo: CapPhoto): Promise<ImageRef>;
  analyse(body: AnalyseRequest): Promise<AnalyseResponse>;
  useAi(): Promise<boolean>;
  newId(): string;
  readonly targetLocationCode?: string;
}

export interface CaptureFlow {
  state(): CaptureState;
  subscribe(listener: (state: CaptureState) => void): () => void;
  /** The top photo was taken or picked. */
  shoot(file: Blob): Promise<void>;
  addUnderside(file: Blob): Promise<void>;
  skipUnderside(): Promise<void>;
  /** Run the failed (or 503) step again with what is already prepared and uploaded. */
  retry(): Promise<void>;
  /** Close the capture: clears the scan context; late results of the abandoned attempt are ignored. */
  cancel(): void;
}

/** `POST /scans/analyse` body from the scan context; a fresh scan never sends `capId` or `known`. */
export function analyseBody(session: CaptureSession): AnalyseRequest {
  const top = session.top;
  if (!top?.ref) throw new Error('top photo not uploaded');
  const body: AnalyseRequest = {
    scanId: session.scanId,
    dhash: top.photo.dhash,
    imageKeys: { top: top.ref.key },
    useAi: session.useAi,
  };
  if (session.underside?.ref) {
    body.dhashUnderside = session.underside.photo.dhash;
    body.imageKeys.underside = session.underside.ref.key;
  }
  if (session.targetLocationCode !== undefined) body.targetLocationCode = session.targetLocationCode;
  return body;
}

function isUnavailable(error: unknown): boolean {
  return (error instanceof ProblemError || error instanceof HttpError) && error.status === 503;
}

export function createCaptureFlow(deps: CaptureDeps): CaptureFlow {
  let state: CaptureState = { step: 'idle' };
  const listeners = new Set<(state: CaptureState) => void>();
  /** Bumped by cancel/new shots: an older attempt's late results no longer apply. */
  let generation = 0;

  function set(next: CaptureState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  /** Runs `step` for the current attempt; false when the attempt was abandoned meanwhile. */
  async function guarded<T>(attempt: number, step: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const value = await step();
    return attempt === generation ? { ok: true, value } : { ok: false };
  }

  async function prepare(attempt: number, side: Side, file: Blob): Promise<boolean> {
    set({ step: 'preparing', side });
    try {
      const result = await guarded(attempt, () => deps.prepare(file));
      if (!result.ok) return false;
      const session = deps.store.current();
      if (session === null) return false;
      session[side] = { photo: result.value };
      return true;
    } catch {
      if (attempt !== generation) return false;
      // Undecodable, no WebP encoder, too large (or anything else while preparing): the user retakes.
      set({ step: 'failed', kind: 'photo', side });
      return false;
    }
  }

  /** Upload what is not uploaded yet, then analyse; ends in `done`, `aiUnavailable` or `failed`. */
  async function submit(attempt: number): Promise<void> {
    const session = deps.store.current();
    if (session === null) return;
    set({ step: 'uploading' });
    try {
      for (const side of ['top', 'underside'] as const) {
        const captured = session[side];
        if (captured === undefined || captured.ref !== undefined) continue;
        const result = await guarded(attempt, () => deps.upload(side, captured.photo));
        if (!result.ok) return;
        captured.ref = result.value;
      }
    } catch {
      if (attempt === generation) set({ step: 'failed', kind: 'upload' });
      return;
    }
    set({ step: 'analysing' });
    try {
      const result = await guarded(attempt, () => deps.analyse(analyseBody(session)));
      if (!result.ok) return;
      session.response = result.value;
      set({ step: 'done', path: routeFor(result.value) });
    } catch (error) {
      if (attempt !== generation) return;
      set(isUnavailable(error) ? { step: 'aiUnavailable' } : { step: 'failed', kind: 'analyse' });
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async shoot(file) {
      const attempt = ++generation;
      const useAi = await deps.useAi();
      if (attempt !== generation) return;
      const target = deps.targetLocationCode;
      deps.store.start({
        scanId: deps.newId(),
        useAi,
        ...(target !== undefined ? { targetLocationCode: target } : {}),
      });
      if (await prepare(attempt, 'top', file)) set({ step: 'underside' });
    },
    async addUnderside(file) {
      const attempt = generation;
      if (await prepare(attempt, 'underside', file)) await submit(attempt);
    },
    skipUnderside: () => submit(generation),
    async retry() {
      const attempt = generation;
      if (state.step === 'failed' && state.kind === 'photo') {
        // A bad underside photo is dropped; a bad top photo means starting over.
        if (state.side === 'underside') return set({ step: 'underside' });
        deps.store.clear();
        return set({ step: 'idle' });
      }
      await submit(attempt);
    },
    cancel() {
      generation++;
      deps.store.clear();
      set({ step: 'idle' });
    },
  };
}
