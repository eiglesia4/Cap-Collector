// Scan tab (SCREENS.md #2, CAP-41): circular guide, Shoot · Library (iPhone, native camera via `platform.camera()`)
// or "Upload photo" (Mac/web, ADR-001: the camera is never called), "Enter manually" (→ the empty form, CAP-25).
// Drives the capture flow (src/capture/flow.ts): optional underside, upload, `POST /scans/analyse`, then the
// outcome's screen; a 503 shows the "AI unavailable" sheet. Opening the tab starts a clean capture: whatever scan
// context was left by Cancel / Retake from a review screen is cleared here. `/scan?pocket=A·3·17` (an empty pocket of
// the album sheet, CAP-52) pre-assigns the scan: `targetLocationCode` goes into the scan context and the analyse body,
// and the review's Save places the new cap there (CapInput.location, CAP-50). CAP-83 (ADR-009, SCREENS.md § Batch
// mode): a Single · Batch switch, remembered in the platform store; in Batch the tray photo (Shoot tray · Library, or
// "Upload tray photo" on the Mac) is handed to Tray adjust in memory. While a batch is unfinished, the batch banner
// (CAP-84: "Batch: 4 of 11 — Continue · Abandon") is shown, and Batch starts no new tray until it is finished or
// abandoned. Cancel (always shown, CAP-90; ADR-010 §3) leaves the capture: the flow is cancelled (scan context
// cleared) and the user goes back to where they came from — the album sheet of a pocket scan, otherwise Collection.
// Styles: styles/scan.css.
import { AnalyseResponse, formatLocationCode } from '@capcollector/shared';

import { albumSheetPath, AlbumListSchema, newIntoPath, pocketLocation } from '../albums/model.js';
import { parseScanMode, SCAN_MODE_KEY, type ScanMode } from '../batch/context.js';
import type { Batch } from '../batch/store.js';
import { BatchBanner } from '../components/batch-banner.js';
import { readUseAi } from '../capture/ai-setting.js';
import { createCaptureFlow, manualEntryPath, type CaptureState } from '../capture/flow.js';
import { newUlid } from '../capture/ulid.js';
import { ScreenHeader } from '../components/screen-header.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { resizeToWebp, type CapPhoto } from '../images/resize.js';
import { uploadImage, type PutFn, type Side } from '../images/upload.js';
import { exchangePath, pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export interface ScanOptions {
  /** Circular crop + dHash; tests inject a fake (happy-dom has no canvas). */
  readonly prepare?: (file: Blob) => Promise<CapPhoto>;
  readonly put?: PutFn;
  readonly newId?: () => string;
  /** Pocket the scan is pre-assigned to (`A·3·17`, from an empty pocket of the album sheet, CAP-52). */
  readonly targetLocationCode?: string;
}

const IMAGE_FILES = { accept: 'image/*' } as const;

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

function revoke(url: string | null): void {
  if (url !== null && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

export function ScanView(ctx: AppContext, options: ScanOptions = {}): HTMLElement {
  const web = ctx.platform.kind === 'web';
  ctx.capture.clear();
  const target = options.targetLocationCode;
  const flow = createCaptureFlow({
    store: ctx.capture,
    prepare: options.prepare ?? ((file) => resizeToWebp(file, { crop: 'circle' })),
    upload: (side, photo) => uploadImage(ctx.api, side, photo, options.put),
    analyse: (body) => ctx.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse }),
    useAi: () => readUseAi(ctx.platform.store),
    newId: options.newId ?? (() => newUlid()),
    ...(target !== undefined ? { targetLocationCode: target } : {}),
  });

  let preview: string | null = null;
  // Batch mode (CAP-83): not offered for a scan pre-assigned to a pocket.
  let mode: ScanMode = 'single';
  let pending: Batch | null = null;
  const switcher = h('div', { class: 'scan-mode', attrs: { role: 'group', 'aria-label': t('scan.mode') } });
  const setMode = async (next: ScanMode) => {
    mode = next;
    pending = next === 'batch' ? await ctx.batch.store.current() : null;
    render(flow.state());
  };
  const modeButton = (value: ScanMode, key: MessageKey) =>
    h(
      'button',
      {
        class: 'scan-mode__option',
        attrs: { type: 'button', 'data-mode': value },
        on: {
          click: () => {
            void ctx.platform.store.set(SCAN_MODE_KEY, value);
            void setMode(value);
          },
        },
      },
      t(key),
    );
  switcher.append(modeButton('single', 'scan.modeSingle'), modeButton('batch', 'scan.modeBatch'));
  const guide = h('div', { class: 'scan-guide', attrs: { role: 'img', 'aria-label': t('scan.guide') } });
  const body = h('div', { class: 'scan-body' });
  const cancel = h(
    'button',
    {
      class: 'header-action',
      attrs: { type: 'button', 'data-action': 'cancel' },
      on: { click: () => void leave() },
    },
    t('common.cancel'),
  );

  /** Cancel on Scan (ADR-010 §3): back to the album sheet of a pocket scan, otherwise (or if it can't be found) Collection. */
  async function leave(): Promise<void> {
    flow.cancel();
    const pocket = pocketLocation(target);
    let path = pathFor('collection');
    if (pocket !== null) {
      try {
        const albums = await ctx.api.request('/albums', { schema: AlbumListSchema });
        const album = albums.find((a) => a.letter === pocket.album);
        if (album) path = albumSheetPath(album.albumId, pocket.sheet);
      } catch {
        // Albums unreachable: Collection is the safe way out.
      }
    }
    ctx.navigate(path);
  }

  /** Native: the camera, or the photo library; web: always a file picker (never the camera). */
  async function take(source: 'camera' | 'library'): Promise<File | null> {
    if (source === 'camera' && !web) return ctx.platform.camera();
    const [file] = await ctx.platform.pickFiles(IMAGE_FILES);
    return file ?? null;
  }

  const button = (key: MessageKey, action: string, onClick: () => unknown, secondary = false, disabled = false) =>
    h(
      'button',
      {
        class: secondary ? 'button button--secondary' : 'button',
        attrs: { type: 'button', 'data-action': action, disabled },
        on: { click: () => void onClick() },
      },
      t(key),
    );

  const pickButtons = (side: Side): HTMLElement[] => {
    const run = (source: 'camera' | 'library') => async () => {
      const file = await take(source);
      if (file === null) return;
      await (side === 'top' ? flow.shoot(file) : flow.addUnderside(file));
    };
    if (web) return [button(side === 'top' ? 'scan.upload' : 'scan.uploadUnderside', 'upload', run('library'))];
    return [
      button(side === 'top' ? 'scan.shoot' : 'scan.shootUnderside', 'shoot', run('camera')),
      button('scan.library', 'library', run('library'), true),
    ];
  };

  /** Batch: the tray photo goes to Tray adjust (in memory only, ADR-009 §2). */
  const trayButtons = (): HTMLElement[] => {
    const run = (source: 'camera' | 'library') => async () => {
      const file = await take(source);
      if (file === null) return;
      ctx.batch.tray.set(file);
      ctx.navigate(pathFor('scanBatchAdjust'));
    };
    if (web) return [button('scan.uploadTray', 'upload-tray', run('library'))];
    return [
      button('scan.shootTray', 'shoot-tray', run('camera')),
      button('scan.library', 'library-tray', run('library'), true),
    ];
  };

  const manual = (href: string) =>
    h(
      'a',
      { class: 'button button--secondary', attrs: { href, 'data-link': true, 'data-action': 'manual' } },
      t('scan.enterManually'),
    );

  const progress = (key: MessageKey) => h('p', { class: 'scan-progress', attrs: { role: 'status' } }, t(key));

  function failure(state: Extract<CaptureState, { step: 'failed' }>): HTMLElement[] {
    const message: MessageKey =
      state.kind === 'photo'
        ? state.side === 'underside'
          ? 'scan.undersideFailed'
          : 'scan.photoFailed'
        : state.kind === 'upload'
          ? 'scan.uploadFailed'
          : 'scan.analyseFailed';
    const again: MessageKey = state.kind === 'photo' ? 'scan.retake' : 'common.retry';
    return [
      h('p', { class: 'status status--error', attrs: { role: 'alert' } }, t(message)),
      button(again, 'retry', () => flow.retry()),
    ];
  }

  function aiUnavailable(): HTMLElement {
    const scanId = ctx.capture.current()?.scanId ?? '';
    return h(
      'div',
      { class: 'sheet scan-sheet', attrs: { role: 'dialog', 'data-sheet': 'ai-unavailable' } },
      h('p', { class: 'sheet-message' }, t('scan.aiUnavailable')),
      manual(manualEntryPath(scanId)),
      // Exchange (CAP-45): this scan's uploaded photos become a request bundle for an external AI.
      button('scan.exportExternal', 'export', () => ctx.navigate(exchangePath({ scanId })), true),
      button('common.retry', 'retry', () => flow.retry(), true),
    );
  }

  function render(state: CaptureState): void {
    if (state.step === 'done') return ctx.navigate(state.path);
    const top = ctx.capture.current()?.top;
    if (top === undefined && preview !== null) {
      revoke(preview);
      preview = null;
    }
    if (top !== undefined && preview === null) preview = objectUrl(top.photo.blob);
    guide.replaceChildren(
      preview === null ? '' : h('img', { class: 'scan-photo', attrs: { src: preview, alt: t('scan.preview') } }),
    );
    const parts: Node[] = [];
    switch (state.step) {
      case 'idle':
        if (target === undefined) parts.push(switcher);
        if (mode === 'batch') {
          parts.push(
            h('p', { class: 'muted scan-batch-hint', attrs: { 'data-hint': 'batch' } }, t('scan.batchHint')),
            // One unfinished batch at a time: the banner above offers Continue · Abandon.
            ...(pending === null
              ? trayButtons()
              : [h('p', { class: 'muted', attrs: { 'data-pending': '' } }, t('scan.batchPending'))]),
          );
          break;
        }
        parts.push(
          h('p', { class: 'muted' }, t(web ? 'scan.uploadHint' : 'scan.hint')),
          ...pickButtons('top'),
          manual(target !== undefined ? newIntoPath(target) : pathFor('newCap')),
        );
        break;
      case 'preparing':
        parts.push(progress('scan.preparing'));
        break;
      case 'underside':
        parts.push(
          h('h2', { class: 'scan-question' }, t('scan.undersideTitle')),
          h('p', { class: 'muted' }, t('scan.undersideHint')),
          ...pickButtons('underside'),
          button('scan.skip', 'skip', () => flow.skipUnderside(), true),
        );
        break;
      case 'uploading':
        parts.push(progress('scan.uploading'));
        break;
      case 'analysing':
        parts.push(progress('scan.analysing'));
        break;
      case 'aiUnavailable':
        parts.push(aiUnavailable());
        break;
      case 'failed':
        parts.push(...failure(state));
        break;
    }
    body.replaceChildren(...parts);
    for (const option of switcher.querySelectorAll<HTMLElement>('[data-mode]')) {
      option.setAttribute('aria-pressed', String(option.dataset.mode === mode));
    }
    el.dataset.step = state.step;
    el.dataset.mode = mode;
  }

  const el = h(
    'section',
    { class: 'screen scan' },
    ScreenHeader(t(web ? 'scan.uploadTitle' : 'scan.title'), cancel),
    target === undefined && BatchBanner(ctx, () => void setMode(mode)),
    target !== undefined &&
      h('p', { class: 'scan-target', attrs: { 'data-target': target } }, t('scan.into', { code: target })),
    guide,
    body,
  );
  flow.subscribe(render);
  render(flow.state());
  if (target === undefined) {
    void ctx.platform.store.get(SCAN_MODE_KEY).then((stored) => {
      const remembered = parseScanMode(stored);
      if (remembered !== mode) void setMode(remembered);
    });
  }
  return el;
}

export const ScanScreen: Screen = (ctx, route) => {
  // Only a well-formed album pocket code pre-assigns the scan; anything else is a plain scan.
  const pocket = pocketLocation(route.query.pocket);
  return ScanView(ctx, pocket ? { targetLocationCode: formatLocationCode(pocket) } : {});
};
