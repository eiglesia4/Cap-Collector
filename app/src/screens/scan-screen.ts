// Scan tab (SCREENS.md #2, CAP-41): circular guide, Shoot · Library (iPhone, native camera via `platform.camera()`)
// or "Upload photo" (Mac/web, ADR-001: the camera is never called), "Enter manually" (→ the empty form, CAP-25).
// Drives the capture flow (src/capture/flow.ts): optional underside, upload, `POST /scans/analyse`, then the
// outcome's screen; a 503 shows the "AI unavailable" sheet. Opening the tab starts a clean capture: whatever scan
// context was left by Cancel / Retake from a review screen is cleared here. Styles: styles/scan.css.
import { AnalyseResponse } from '@capcollector/shared';

import { readUseAi } from '../capture/ai-setting.js';
import { createCaptureFlow, manualEntryPath, type CaptureState } from '../capture/flow.js';
import { newUlid } from '../capture/ulid.js';
import { ScreenHeader } from '../components/screen-header.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { resizeToWebp, type CapPhoto } from '../images/resize.js';
import { uploadImage, type PutFn, type Side } from '../images/upload.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export interface ScanOptions {
  /** Circular crop + dHash; tests inject a fake (happy-dom has no canvas). */
  readonly prepare?: (file: Blob) => Promise<CapPhoto>;
  readonly put?: PutFn;
  readonly newId?: () => string;
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
  const flow = createCaptureFlow({
    store: ctx.capture,
    prepare: options.prepare ?? ((file) => resizeToWebp(file, { crop: 'circle' })),
    upload: (side, photo) => uploadImage(ctx.api, side, photo, options.put),
    analyse: (body) => ctx.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse }),
    useAi: () => readUseAi(ctx.platform.store),
    newId: options.newId ?? (() => newUlid()),
  });

  let preview: string | null = null;
  const guide = h('div', { class: 'scan-guide', attrs: { role: 'img', 'aria-label': t('scan.guide') } });
  const body = h('div', { class: 'scan-body' });
  const cancel = h(
    'button',
    {
      class: 'header-action',
      attrs: { type: 'button', 'data-action': 'cancel' },
      on: { click: () => flow.cancel() },
    },
    t('common.cancel'),
  );

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
      button('scan.exportExternal', 'export', () => undefined, true, true),
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
    cancel.hidden = state.step === 'idle';
    const parts: Node[] = [];
    switch (state.step) {
      case 'idle':
        parts.push(
          h('p', { class: 'muted' }, t(web ? 'scan.uploadHint' : 'scan.hint')),
          ...pickButtons('top'),
          manual(pathFor('newCap')),
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
    el.dataset.step = state.step;
  }

  const el = h(
    'section',
    { class: 'screen scan' },
    ScreenHeader(t(web ? 'scan.uploadTitle' : 'scan.title'), cancel),
    guide,
    body,
  );
  flow.subscribe(render);
  render(flow.state());
  return el;
}

export const ScanScreen: Screen = (ctx) => ScanView(ctx);
