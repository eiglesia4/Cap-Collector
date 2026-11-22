// Circle overlay over a photo (CAP-89, extracted from Tray adjust, CAP-83; SCREENS.md § Batch mode "2b Tray adjust"
// and § Navigation logic "crop check", ADR-010 §2): an SVG in detection pixels over the image. Tap a circle to select
// it; drag to move; the corner handle or the slider resizes it. Two modes:
//   - `tray`: numbered circles in reading order (uncertain ones dashed), Remove, tap an empty spot to add one at the
//     median size (at most MAX_CIRCLES);
//   - `single`: exactly one circle, always selected (no add, no remove), for the single capture's crop check.
import { t } from '../i18n/i18n.js';
import { h } from '../ui/dom.js';
import { MAX_CIRCLES, readingOrder } from '../vision/segment.js';

export interface EditableCircle {
  cx: number;
  cy: number;
  r: number;
  uncertain: boolean;
}

export interface CircleEditorOptions {
  readonly mode: 'tray' | 'single';
  /** Detection raster size: the SVG viewBox. */
  readonly width: number;
  readonly height: number;
  /** Typical radius: size of an added circle, slider range and minimum size. */
  readonly median: number;
  readonly circles: readonly EditableCircle[];
  /** After every redraw (count, Start label…). */
  onChange?(circles: readonly EditableCircle[]): void;
  /** Tray: an add was refused at MAX_CIRCLES. */
  onLimit?(): void;
  /** No edits while true (cropping). */
  busy?(): boolean;
}

export interface CircleEditor {
  readonly overlay: SVGSVGElement;
  /** Slider (and Remove in tray mode); hidden while nothing is selected. */
  readonly controls: HTMLElement;
  circles(): readonly EditableCircle[];
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

export function CircleEditor(options: CircleEditorOptions): CircleEditor {
  const { mode, width, height, median } = options;
  const single = mode === 'single';
  let circles: EditableCircle[] = options.circles.map((c) => ({ ...c }));
  let selected: EditableCircle | null = single ? (circles[0] ?? null) : null;
  const busy = () => options.busy?.() ?? false;

  const overlay = svg('svg', { class: 'tray-overlay', preserveAspectRatio: 'xMidYMid meet' });
  overlay.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`);
  if (single) overlay.setAttribute('data-single', '');
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
  const controls = h('div', { class: 'tray-editor' }, slider, ...(single ? [] : [remove]));

  /** Pointer position in detection pixels (the SVG viewBox). */
  function point(event: MouseEvent): { x: number; y: number } {
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: event.clientX, y: event.clientY };
    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
    };
  }

  const clampCircle = (c: EditableCircle) => {
    c.r = Math.min(Math.max(c.r, median * 0.3), Math.max(width, height) / 2);
    c.cx = Math.min(Math.max(c.cx, 0), width);
    c.cy = Math.min(Math.max(c.cy, 0), height);
  };

  /** After an edit: reading order again (tray), then draw. */
  function edited(): void {
    if (!single) circles = readingOrder(circles, median);
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
        if (!single) {
          const label = svg('text', { x: c.cx, y: c.cy, 'font-size': Math.max(12, c.r * 0.6) });
          label.textContent = String(i + 1);
          g.append(label);
        }
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
    controls.hidden = selected === null;
    options.onChange?.(circles);
  }

  // ── pointer: select / move / resize / add ──
  let drag: { kind: 'move' | 'resize'; circle: EditableCircle; dx: number; dy: number } | null = null;
  overlay.addEventListener('pointerdown', (event) => {
    if (busy()) return;
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
      } else if (single) {
        return;
      } else if (circles.length >= MAX_CIRCLES) {
        options.onLimit?.();
        return;
      } else {
        const added: EditableCircle = { cx: p.x, cy: p.y, r: median, uncertain: false };
        clampCircle(added);
        circles = [...circles, added];
        selected = added;
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

  draw();
  return { overlay, controls, circles: () => circles };
}
