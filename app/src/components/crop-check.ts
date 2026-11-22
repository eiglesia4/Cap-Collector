// Crop check of the single capture (CAP-89; ADR-010 §2; SCREENS.md § Navigation logic "Single capture"): after the
// shot, pick or upload — top and underside alike — the photo is decoded once, drawn at ≤ 1600 px for `detectCaps`, and
// shown with one circle placed by the detector: the confident circle nearest the centre, else the largest, else a
// centred circle of 40 % of the short edge. The user can move or resize it (circle-editor.ts, single mode) and taps
// **Use photo**: the cap is cropped from the full-resolution photo exactly like a batch crop (`cropCircle`: dHash of
// the inscribed square, circular mask, WebP), so single and batch dHashes stay comparable (ADR-004, ADR-009).
import type { Side } from '../images/upload.js';
import { t } from '../i18n/i18n.js';
import { browserCodec, fitWithin, type CapPhoto, type DecodedImage, type RasterCodec } from '../images/resize.js';
import { h } from '../ui/dom.js';
import { cropCircle } from '../vision/crop.js';
import { detectCaps, type DetectedCircle, type Detection } from '../vision/segment.js';
import { CircleEditor, type EditableCircle } from './circle-editor.js';

/** Long edge of the raster `detectCaps` works on (same as Tray adjust, ADR-009 §1). */
export const CHECK_EDGE = 1600;
/** Diameter of the fallback circle, as a share of the photo's short edge (ADR-010 §2). */
export const FALLBACK_DIAMETER = 0.4;

export interface CropCheckDeps {
  /** Decoder / drawer / encoder; tests inject a fake (happy-dom has no canvas). */
  readonly codec?: RasterCodec;
  readonly detect?: typeof detectCaps;
  readonly crop?: typeof cropCircle;
}

export interface CropCheckOptions extends CropCheckDeps {
  readonly file: Blob;
  readonly side: Side;
  /** The cropped cap; the capture flow continues with it. */
  onUse(photo: CapPhoto): unknown;
  /** Back to Scan (top) or to the underside question (underside). */
  onRetake(): void;
}

/** Where the single circle starts (ADR-010 §2), in raster pixels of a width × height detection. */
export function singleCircle(detection: Pick<Detection, 'circles'>, width: number, height: number): DetectedCircle {
  const cx = width / 2;
  const cy = height / 2;
  const confident = detection.circles.filter((c) => !c.uncertain);
  if (confident.length > 0) {
    const distance = (c: DetectedCircle) => Math.hypot(c.cx - cx, c.cy - cy);
    return confident.reduce((best, c) => (distance(c) < distance(best) ? c : best));
  }
  if (detection.circles.length > 0) return detection.circles.reduce((best, c) => (c.r > best.r ? c : best));
  return { cx, cy, r: (Math.min(width, height) * FALLBACK_DIAMETER) / 2, uncertain: false };
}

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

export function CropCheck(options: CropCheckOptions): HTMLElement {
  const codec = options.codec ?? browserCodec();
  const detect = options.detect ?? detectCaps;
  const crop = options.crop ?? cropCircle;
  const failed = options.side === 'top' ? 'scan.photoFailed' : 'scan.undersideFailed';

  let image: DecodedImage | null = null;
  let scale = 1;
  let editor: CircleEditor | null = null;
  let busy = false;

  const status = h('p', { class: 'status', attrs: { role: 'status', 'data-status': '' } });
  const use = h(
    'button',
    {
      class: 'button',
      attrs: { type: 'button', 'data-action': 'use-photo', disabled: true },
      on: { click: () => void run() },
    },
    t('scan.usePhoto'),
  );
  const retake = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button', 'data-action': 'crop-retake' },
      on: {
        click: () => {
          if (busy) return;
          image?.close?.();
          options.onRetake();
        },
      },
    },
    t('scan.retake'),
  );
  const stage = h(
    'div',
    { class: 'crop-check__stage' },
    h('p', { class: 'muted', attrs: { role: 'status' } }, t('scan.checking')),
  );
  const el = h(
    'div',
    { class: 'crop-check', attrs: { 'data-crop-check': options.side } },
    h('h2', { class: 'scan-question' }, t(options.side === 'top' ? 'scan.checkTitle' : 'scan.checkUndersideTitle')),
    stage,
    status,
    use,
    retake,
  );

  const fail = () => {
    status.textContent = t(failed);
    status.setAttribute('role', 'alert');
    status.classList.add('status--error');
  };

  async function run(): Promise<void> {
    const circle = editor?.circles()[0];
    if (busy || image === null || circle === undefined) return;
    busy = true;
    use.disabled = true;
    status.textContent = t('scan.cropping');
    try {
      const photo = await crop({ image, codec }, circle, scale);
      image.close?.();
      await options.onUse(photo);
    } catch {
      busy = false;
      use.disabled = false;
      fail();
    }
  }

  async function load(): Promise<void> {
    try {
      image = await codec.decode(options.file);
      const { width, height } = fitWithin(image.width, image.height, CHECK_EDGE);
      const raster = await codec.raster(image, { sx: 0, sy: 0, sw: image.width, sh: image.height }, width, height);
      if (raster === null) throw new Error('no 2D canvas');
      const detection = detect(raster, { sourceWidth: image.width });
      scale = detection.scale;
      const placed: EditableCircle = { ...singleCircle(detection, width, height), uncertain: false };
      const ed = CircleEditor({ mode: 'single', width, height, median: placed.r, circles: [placed], busy: () => busy });
      editor = ed;
      const url = objectUrl(options.file);
      stage.replaceChildren(
        h(
          'div',
          { class: 'tray-stage', attrs: { style: `aspect-ratio: ${String(width)} / ${String(height)}` } },
          url === null ? '' : h('img', { class: 'tray-photo', attrs: { src: url, alt: t('scan.preview') } }),
          ed.overlay,
        ),
        h('p', { class: 'muted field-hint' }, t('scan.checkHint')),
        ed.controls,
      );
      use.disabled = false;
    } catch {
      stage.replaceChildren();
      fail();
    }
  }

  void load();
  return el;
}
