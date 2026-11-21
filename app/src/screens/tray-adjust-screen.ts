// Tray adjust (CAP-83; SCREENS.md § Batch mode "2b Tray adjust"; ADR-009 §1–2, §5): `/scan/batch/adjust`, after the
// tray shot or pick. The photo (in memory, ctx.batch.tray) is decoded once and drawn at ≤ 1600 px for `detectCaps`;
// it shows with one numbered circle per cap in reading order (an SVG over the image, in detection pixels; uncertain
// circles dashed). Tap a circle to select it; drag it to move; the corner handle or the slider resizes it; Remove
// deletes it. Tap an empty spot to add a circle at the median size. Every edit renumbers in reading order; at most 30.
// Zero found → "No caps found…" with Retake and Add by hand. "Propose next free pocket" is off by default and goes
// into the batch. Start (n) crops every circle from the full-resolution photo (`cropCircle`), stores the batch on the
// device (ctx.batch.store) and opens `/scan/batch`; the tray photo is dropped, never stored or uploaded (ADR-009 §2).
import { clockOf, type AppContext, type Screen } from '../context.js';
import type { BatchItem } from '../batch/store.js';
import { newUlid } from '../capture/ulid.js';
import { t } from '../i18n/i18n.js';
import { browserCodec, fitWithin, type DecodedImage, type RasterCodec } from '../images/resize.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';
import { cropCircle } from '../vision/crop.js';
import { detectCaps, MAX_CIRCLES, readingOrder, type DetectedCircle } from '../vision/segment.js';

/** Long edge of the raster `detectCaps` works on (ADR-009 §1). */
export const DETECT_EDGE = 1600;

export interface TrayAdjustOptions {
  /** Decoder / drawer / encoder; tests inject a fake (happy-dom has no canvas). */
  readonly codec?: RasterCodec;
  readonly detect?: typeof detectCaps;
  readonly crop?: typeof cropCircle;
  readonly newId?: () => string;
}

interface Circle {
  cx: number;
  cy: number;
  r: number;
  uncertain: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
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
  let circles: Circle[] = [];
  let selected: Circle | null = null;
  let placeAsYouGo = false;
  let busy = false;

  const status = h('p', { class: 'status', attrs: { role: 'status', 'data-status': '' } });
  const overlay = svg('svg', { class: 'tray-overlay', preserveAspectRatio: 'xMidYMid meet' });
  const slider = h('input', {
    class: 'tray-size',
    attrs: { type: 'range', 'aria-label': t('batch.size'), 'data-action': 'size' },
  });
  const remove = h(
    'button',
    {
      class: 'button button--secondary button--small',
      attrs: { type: 'button', 'data-action': 'remove' },
      on: {
        click: () => {
          circles = circles.filter((c) => c !== selected);
          selected = null;
          edited();
        },
      },
    },
    t('batch.remove'),
  );
  const editor = h('div', { class: 'tray-editor' }, slider, remove);
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

  /** Pointer position in detection pixels (the SVG viewBox). */
  function point(event: MouseEvent): { x: number; y: number } {
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: event.clientX, y: event.clientY };
    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
    };
  }

  const clampCircle = (c: Circle) => {
    c.r = Math.min(Math.max(c.r, median * 0.3), Math.max(width, height) / 2);
    c.cx = Math.min(Math.max(c.cx, 0), width);
    c.cy = Math.min(Math.max(c.cy, 0), height);
  };

  /** After an edit: reading order again, then draw. */
  function edited(): void {
    circles = readingOrder(circles, median);
    draw();
  }

  function draw(): void {
    overlay.replaceChildren(
      ...circles.map((c, i) => {
        const g = svg('g', { class: 'tray-circle', 'data-index': i });
        if (c === selected) g.setAttribute('data-selected', '');
        if (c.uncertain) g.setAttribute('data-uncertain', '');
        g.append(
          svg('circle', {
            cx: c.cx,
            cy: c.cy,
            r: c.r,
            ...(c.uncertain ? { 'stroke-dasharray': `${String(c.r / 4)} ${String(c.r / 6)}` } : {}),
          }),
        );
        const label = svg('text', { x: c.cx, y: c.cy, 'font-size': Math.max(12, c.r * 0.6) });
        label.textContent = String(i + 1);
        g.append(label);
        return g;
      }),
    );
    if (selected) {
      const d = selected.r * Math.SQRT1_2;
      overlay.append(
        svg('circle', {
          class: 'tray-handle',
          'data-handle': '',
          cx: selected.cx + d,
          cy: selected.cy + d,
          r: Math.max(8, median * 0.25),
        }),
      );
      slider.min = String(Math.round(median * 0.4));
      slider.max = String(Math.round(median * 2));
      slider.value = String(Math.round(selected.r));
    }
    editor.hidden = selected === null;
    count.textContent = t(circles.length === 1 ? 'batch.countOne' : 'batch.count', { count: circles.length });
    start.textContent = t('batch.start', { count: circles.length });
    start.disabled = busy || circles.length === 0;
  }

  // ── pointer: select / move / resize / add ──
  let drag: { kind: 'move' | 'resize'; circle: Circle; dx: number; dy: number } | null = null;
  overlay.addEventListener('pointerdown', (event) => {
    if (busy) return;
    const p = point(event);
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-handle]') && selected) {
      drag = { kind: 'resize', circle: selected, dx: 0, dy: 0 };
    } else {
      const hit = target?.closest('[data-index]');
      const index = hit ? Number(hit.getAttribute('data-index')) : -1;
      const circle = circles[index];
      if (circle) {
        selected = circle;
        drag = { kind: 'move', circle, dx: p.x - circle.cx, dy: p.y - circle.cy };
      } else if (circles.length >= MAX_CIRCLES) {
        say(t('batch.limit', { max: MAX_CIRCLES }), true);
        return;
      } else {
        const added: Circle = { cx: p.x, cy: p.y, r: median, uncertain: false };
        clampCircle(added);
        circles = [...circles, added];
        selected = added;
        say('');
        edited();
        return;
      }
    }
    if ('pointerId' in event && typeof overlay.setPointerCapture === 'function') {
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch {
        // Not every engine captures synthetic pointers.
      }
    }
    draw();
  });
  overlay.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const p = point(event);
    const c = drag.circle;
    if (drag.kind === 'move') {
      c.cx = p.x - drag.dx;
      c.cy = p.y - drag.dy;
    } else {
      c.r = Math.hypot(p.x - c.cx, p.y - c.cy);
    }
    c.uncertain = false;
    clampCircle(c);
    draw();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    edited();
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', end);
  slider.addEventListener('input', () => {
    if (!selected) return;
    selected.r = Number(slider.value);
    selected.uncertain = false;
    clampCircle(selected);
    edited();
  });

  // ── Start: crop from full resolution, store the batch ──
  async function run(): Promise<void> {
    if (busy || image === null || circles.length === 0) return;
    busy = true;
    draw();
    const items: BatchItem[] = [];
    try {
      for (const [index, circle] of circles.entries()) {
        say(t('batch.cropping', { done: index + 1, total: circles.length }));
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
      draw();
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
    overlay.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`);
    body.replaceChildren(
      h(
        'div',
        { class: 'tray-stage', attrs: { style: `aspect-ratio: ${String(width)} / ${String(height)}` } },
        url === null ? '' : h('img', { class: 'tray-photo', attrs: { src: url, alt: t('batch.trayPhoto') } }),
        overlay,
      ),
      h('p', { class: 'muted field-hint' }, t('batch.adjustHint')),
      editor,
      h('label', { class: 'field field--row' }, toggle, h('span', {}, t('batch.placeAsYouGo'))),
      status,
      start,
    );
    draw();
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
      circles = detection.circles.map((c: DetectedCircle) => ({ ...c }));
      const url = objectUrl(tray);
      if (circles.length === 0) emptyView(url);
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
