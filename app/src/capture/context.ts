// The scan context of one capture (CAP-41, SCREENS.md § Navigation: the capture flow is a full-screen modal over the
// tabs). It lives in memory for the modal's lifetime: the scan id, the prepared photos and their dHashes, the uploaded
// image refs and the `/scans/analyse` answer. The review screens (Already in collection CAP-42, AI review CAP-43,
// Manual entry CAP-25) read it; closing the modal (Cancel, Retake, Discard, Save) clears it. Never persisted.
import type { AnalyseResponse, ImageRef } from '@capcollector/shared';

import type { CapPhoto } from '../images/resize.js';

export interface CapturedSide {
  readonly photo: CapPhoto;
  /** Set once the photo is uploaded (`POST /uploads` + presigned PUT). */
  ref?: ImageRef;
}

export interface CaptureSession {
  readonly scanId: string;
  /** "Use AI identification" as it was when the scan started (Settings). */
  readonly useAi: boolean;
  /** Pocket the scan was started from (album sheet, CAP-52); none from the Scan tab. */
  readonly targetLocationCode?: string;
  top?: CapturedSide;
  underside?: CapturedSide;
  response?: AnalyseResponse;
}

export interface CaptureStore {
  current(): CaptureSession | null;
  /** Start a new capture, dropping any previous one. */
  start(session: CaptureSession): CaptureSession;
  clear(): void;
}

export function createCaptureStore(): CaptureStore {
  let session: CaptureSession | null = null;
  return {
    current: () => session,
    start: (next) => (session = next),
    clear: () => {
      session = null;
    },
  };
}
