// Tray adjust (CAP-83; SCREENS.md § Batch mode "2b Tray adjust"; ADR-009 §1–2, §5): `/scan/batch/adjust`, after the
// tray shot or pick. The photo (in memory, ctx.batch.tray) is decoded once and drawn at ≤ 1600 px for `detectCaps`;
// it shows with one numbered circle per cap in reading order (an SVG over the image, in detection pixels; uncertain
// circles dashed). Tap a circle to select it; drag it to move; the corner handle or the slider resizes it; Remove
// deletes it. Tap an empty spot to add a circle at the median size. Every edit renumbers in reading order; at most 30.
// Zero found → "No caps found…" with Retake and Add by hand. "Propose next free pocket" is off by default and goes
// into the batch. Start (n) crops every circle from the full-resolution photo (`cropCircle`), stores the batch on the
// device (ctx.batch.store) and opens `/scan/batch`; the tray photo is dropped, never stored or uploaded (ADR-009 §2).
// The overlay and its gestures are components/circle-editor.ts (tray mode), shared with the single crop check (CAP-89).
import { CircleEditor, type EditableCircle } from '../components/circle-editor.js';
import { clockOf, type AppContext, type Screen } from '../context.js';
import type { BatchItem } from '../batch/store.js';
import { newUlid } from '../capture/ulid.js';
import { t } from '../i18n/i18n.js';
import { browserCodec, fitWithin, type DecodedImage, type RasterCodec } from '../images/resize.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';
import { cropCircle } from '../vision/crop.js';
import { detectCaps, MAX_CIRCLES, type DetectedCircle } from '../vision/segment.js';

/** Long edge of the raster `detectCaps` works on (ADR-009 §1). */
export const DETECT_EDGE = 1600;

export interface TrayAdjustOptions {
  /** Decoder / drawer / encoder; tests inject a fake (happy-dom has no canvas). */
  readonly codec?: RasterCodec;
  readonly detect?: typeof detectCaps;
  readonly crop?: typeof cropCircle;
  readonly newId?: () => string;
}

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

export function TrayAdjustView(ctx: AppContext, options: TrayAdjustOptions = {}): HTMLElement {
  const codec = options.codec ?? browserCodec();
  const detect = options.detect ?? detectCaps;
  const crop = options.crop ?? cropCircle;
  const newId = options.newId ?? (() => newUlid());

  const count = h('h1', { class: 'screen-title', attrs: { 'data-count': '' } }, t('batch.loading'));
  const retake = h(
    'button',
    { class: 'header-action', attrs: { type: 'button', 'data-action': 'retake' }, on: { click: () => back() } },
    t('scan.retake'),
  );
  const body = h('div', { class: 'tray-body' });
  const el = h(
    'section',
    { class: 'screen tray-adjust' },
    h('header', { class: 'screen-header' }, retake, count),
    body,
  );

  let image: DecodedImage | null = null;
  let width = 0;
  let height = 0;
  let scale = 1;
  let median = 0;
  let detected: EditableCircle[] = [];
  let editor: CircleEditor | null = null;
  let placeAsYouGo = false;
  let busy = false;

  const status = h('p', { class: 'status', attrs: { role: 'status', 'data-status': '' } });
  const start = h('button', {
    class: 'button',
    attrs: { type: 'button', 'data-action': 'start' },
    on: { click: () => void run() },
  });

  function back(): void {
    ctx.batch.tray.clear();
    image?.close?.();
    ctx.navigate(pathFor('scan'));
  }

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('status--error', error);
  };

  const circles = (): readonly EditableCircle[] => editor?.circles() ?? [];

  /** Header count and Start label follow the circles. */
  function counted(list: readonly EditableCircle[]): void {
    count.textContent = t(list.length === 1 ? 'batch.countOne' : 'batch.count', { count: list.length });
    start.textContent = t('batch.start', { count: list.length });
    start.disabled = busy || list.length === 0;
  }

  // ── Start: crop from full resolution, store the batch ──
  async function run(): Promise<void> {
    const list = circles();
    if (busy || image === null || list.length === 0) return;
    busy = true;
    counted(list);
    const items: BatchItem[] = [];
    try {
      for (const [index, circle] of list.entries()) {
        say(t('batch.cropping', { done: index + 1, total: list.length }));
        const photo = await crop({ image, codec }, circle, scale);
        items.push({
          index,
          photo: photo.blob,
          dhash: photo.dhash,
          width: photo.width,
          height: photo.height,
          state: 'waiting',
        });
      }
      await ctx.batch.store.save({
        batchId: newId(),
        createdAt: clockOf(ctx).toISOString(),
        placeAsYouGo,
        items,
      });
    } catch {
      busy = false;
      say(t('batch.cropFailed'), true);
      counted(list);
      return;
    }
    // ADR-009 §2: the tray photo is never kept.
    ctx.batch.tray.clear();
    image.close?.();
    ctx.navigate(pathFor('scanBatch'));
  }

  function editorView(url: string | null): void {
    const toggle = h('input', { attrs: { type: 'checkbox', name: 'place-as-you-go' } });
    toggle.checked = placeAsYouGo;
    toggle.addEventListener('change', () => (placeAsYouGo = toggle.checked));
    const ed = CircleEditor({
      mode: 'tray',
      width,
      height,
      median,
      circles: detected,
      onChange: counted,
      onLimit: () => say(t('batch.limit', { max: MAX_CIRCLES }), true),
      busy: () => busy,
    });
    editor = ed;
    body.replaceChildren(
      h(
        'div',
        { class: 'tray-stage', attrs: { style: `aspect-ratio: ${String(width)} / ${String(height)}` } },
        url === null ? '' : h('img', { class: 'tray-photo', attrs: { src: url, alt: t('batch.trayPhoto') } }),
        ed.overlay,
      ),
      h('p', { class: 'muted field-hint' }, t('batch.adjustHint')),
      ed.controls,
      h('label', { class: 'field field--row' }, toggle, h('span', {}, t('batch.placeAsYouGo'))),
      status,
      start,
    );
  }

  function emptyView(url: string | null): void {
    count.textContent = t('batch.count', { count: 0 });
    body.replaceChildren(
      h('p', { class: 'status', attrs: { role: 'status', 'data-empty': '' } }, t('batch.noneFound')),
      h(
        'button',
        { class: 'button', attrs: { type: 'button', 'data-action': 'retake-empty' }, on: { click: () => back() } },
        t('scan.retake'),
      ),
      h(
        'button',
        {
          class: 'button button--secondary',
          attrs: { type: 'button', 'data-action': 'add-by-hand' },
          on: { click: () => editorView(url) },
        },
        t('batch.addByHand'),
      ),
    );
  }

  async function load(): Promise<void> {
    const tray = ctx.batch.tray.current();
    if (tray === null) {
      count.textContent = t('batch.title');
      body.replaceChildren(h('p', { attrs: { role: 'alert' } }, t('batch.noTray')));
      return;
    }
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('batch.detecting')));
    try {
      image = await codec.decode(tray);
      ({ width, height } = fitWithin(image.width, image.height, DETECT_EDGE));
      const raster = await codec.raster(image, { sx: 0, sy: 0, sw: image.width, sh: image.height }, width, height);
      if (raster === null) throw new Error('no 2D canvas');
      const detection = detect(raster, { sourceWidth: image.width });
      scale = detection.scale;
      median = detection.medianRadius > 0 ? detection.medianRadius : Math.min(width, height) / 12;
      detected = detection.circles.map((c: DetectedCircle) => ({ ...c }));
      const url = objectUrl(tray);
      if (detected.length === 0) emptyView(url);
      else editorView(url);
      if (detection.truncated) say(t('batch.truncated', { max: MAX_CIRCLES }), true);
    } catch {
      count.textContent = t('batch.title');
      body.replaceChildren(h('p', { attrs: { role: 'alert' } }, t('batch.decodeFailed')));
    }
  }

  void load();
  return el;
}

export const TrayAdjustScreen: Screen = (ctx) => TrayAdjustView(ctx);
