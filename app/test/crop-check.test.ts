// Crop check before every single capture (CAP-89; ADR-010 §2; SCREENS.md § Navigation logic): the detector places one
// circle (most central confident one, else the largest, else a centred 40 % circle), the user moves or resizes it,
// Use photo crops it from the full-resolution photo and hands the `CapPhoto` to the capture flow; top and underside
// alike, pocket scans included. Codec, detector and cropper are fakes (happy-dom has no canvas).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { CropCheck, FALLBACK_DIAMETER, singleCircle } from '../src/components/crop-check';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { ScanView } from '../src/screens/scan-screen';
import { cropSquare } from '../src/vision/crop';
import type { DetectedCircle } from '../src/vision/segment';
import { ulid } from './support/caps';
import { fakeApi, fakeCropCheck, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SCAN_ID = ulid(89);
const TOP_HASH = 'f0f0f03030f0f0f0';
const UNDER_HASH = '866796a6a6966796';
// fakeCropCheck: a 2000 × 1500 photo drawn at 1600 × 1200 for the detector (scale 1.25).
const W = 1600;
const H = 1200;

const photo = (dhash: string): CapPhoto => ({
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 512,
  height: 512,
  dhash,
});

const circle = (cx: number, cy: number, r: number, uncertain = false): DetectedCircle => ({ cx, cy, r, uncertain });
const detection = (circles: DetectedCircle[]) => ({ circles, medianRadius: 0, scale: 1.25, truncated: false });

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

/** The drawn circle of the check, as numbers. */
function drawn(root: ParentNode): { cx: number; cy: number; r: number } {
  const c = $(root, '[data-index="0"] circle');
  return { cx: Number(c.getAttribute('cx')), cy: Number(c.getAttribute('cy')), r: Number(c.getAttribute('r')) };
}

function check(found: DetectedCircle[]) {
  const deps = fakeCropCheck(() => photo(TOP_HASH));
  deps.detect.mockReturnValue(detection(found));
  const onUse = vi.fn();
  const onRetake = vi.fn();
  const el = CropCheck({ ...deps, file: new Blob(['t']), side: 'top', onUse, onRetake });
  document.body.replaceChildren(el);
  return { el, deps, onUse, onRetake };
}

async function scan(targetLocationCode?: string) {
  const calls: { path: string; body: unknown }[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    calls.push({ path, body: opts.body });
    const answer =
      path === '/uploads'
        ? {
            key: `u1/${SCAN_ID}/${(opts.body as { side: string }).side}.webp`,
            url: 'https://s3.test/put',
            expiresAt: '2030-01-01T00:00:00.000Z',
          }
        : { scanId: SCAN_ID, outcome: 'identified', suggestions: [] };
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform('web', memoryStore());
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = { ...(await shellContext({ api, platform })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const deps = fakeCropCheck((file) => photo(file.size === 2 ? UNDER_HASH : TOP_HASH));
  const el = ScanView(ctx, {
    check: deps,
    put: async () => new Response(null, { status: 200 }),
    newId: () => SCAN_ID,
    ...(targetLocationCode !== undefined ? { targetLocationCode } : {}),
  });
  document.body.replaceChildren(el);
  const pick = async (name: string) => {
    vi.mocked(platform.pickFiles).mockResolvedValueOnce([new File([name], `${name}.jpg`)]);
    $(el, '[data-action="upload"]').click();
    await settle();
  };
  return { el, ctx, calls, deps, pick };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('crop check', () => {
  it('[T-app-171] a photo with an off-centre cap → the circle is placed on it, and Use photo crops that circle', async () => {
    const { el, deps, onUse } = check([circle(1200, 300, 150)]);
    expect(el.querySelector('[role="status"]')?.textContent).toBe(t('scan.checking'));
    await settle();
    expect(drawn(el)).toEqual({ cx: 1200, cy: 300, r: 150 });
    expect(deps.detect).toHaveBeenCalledWith(expect.objectContaining({ width: W, height: H }), { sourceWidth: 2000 });
    // One circle only: always selected, the slider shown, no Remove and no numbering.
    expect(el.querySelector('[data-index="0"]')?.hasAttribute('data-selected')).toBe(true);
    expect($<HTMLElement>(el, '.tray-editor').hidden).toBe(false);
    expect(el.querySelector('[data-action="remove"]')).toBeNull();
    expect(el.querySelector('text')).toBeNull();

    $(el, '[data-action="use-photo"]').click();
    await settle();
    expect(deps.crop).toHaveBeenCalledWith(
      expect.objectContaining({ codec: deps.codec }),
      expect.objectContaining({ cx: 1200, cy: 300, r: 150 }),
      1.25,
    );
    expect(onUse).toHaveBeenCalledWith(photo(TOP_HASH));
  });

  it('[T-app-172] no detection → a centred circle of 40 % of the short edge; an empty tap does not add a circle', async () => {
    expect(singleCircle({ circles: [] }, W, H)).toEqual({
      cx: 800,
      cy: 600,
      r: (H * FALLBACK_DIAMETER) / 2,
      uncertain: false,
    });
    const { el } = check([]);
    await settle();
    expect(drawn(el)).toEqual({ cx: 800, cy: 600, r: 240 });
    $(el, 'svg').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
    expect(el.querySelectorAll('[data-index]')).toHaveLength(1);
  });

  it('[T-app-173] several detections → the most central confident one; only uncertain ones → the largest', async () => {
    const found = [circle(200, 200, 300), circle(900, 650, 100), circle(820, 590, 120, true), circle(1400, 1000, 90)];
    expect(singleCircle({ circles: found }, W, H)).toBe(found[1]);
    const unsure = [circle(300, 300, 80, true), circle(1300, 900, 140, true)];
    expect(singleCircle({ circles: unsure }, W, H)).toBe(unsure[1]);
    const { el } = check(found);
    await settle();
    expect(drawn(el)).toEqual({ cx: 900, cy: 650, r: 100 });
  });

  it('[T-app-174] moving and resizing change the crop passed to cropCircle (full-resolution through the scale)', async () => {
    const { el, deps } = check([circle(800, 600, 200)]);
    await settle();
    const pointer = (target: Element, type: string, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    const overlay = $(el, 'svg');
    // Drag by (+100, −50): with no layout the pointer is already in detection pixels.
    pointer($(el, '[data-index="0"]'), 'pointerdown', 800, 600);
    pointer(overlay, 'pointermove', 900, 550);
    pointer(overlay, 'pointerup', 900, 550);
    expect(drawn(el)).toMatchObject({ cx: 900, cy: 550 });
    // Resize with the slider.
    const slider = $<HTMLInputElement>(el, '[data-action="size"]');
    slider.value = '260';
    slider.dispatchEvent(new Event('input'));
    expect(drawn(el).r).toBe(260);

    $(el, '[data-action="use-photo"]').click();
    await settle();
    const [, used, scale] = deps.crop.mock.calls[0] as unknown as [unknown, DetectedCircle, number];
    expect(used).toMatchObject({ cx: 900, cy: 550, r: 260 });
    // In the 2000 × 1500 photo: centre (1125, 687.5), side 2·260·1.25·1.06 ≈ 689.
    expect(cropSquare(used, scale, 2000, 1500)).toEqual({ sx: 781, sy: 343, sw: 689, sh: 689 });
  });

  it('[T-app-175] Retake returns to Scan (top) or to the underside question; nothing reaches the flow', async () => {
    const top = check([]);
    await settle();
    $(top.el, '[data-action="crop-retake"]').click();
    expect(top.onRetake).toHaveBeenCalledTimes(1);
    expect(top.onUse).not.toHaveBeenCalled();

    const s = await scan();
    await s.pick('t');
    expect(s.el.dataset.step).toBe('check');
    expect(s.el.querySelector('.scan-guide')?.hasAttribute('hidden')).toBe(true);
    $(s.el, '[data-action="crop-retake"]').click();
    expect(s.el.dataset.step).toBe('idle');
    expect(s.ctx.capture.current()).toBeNull();
    expect(s.el.querySelector('[data-action="upload"]')?.textContent).toBe(t('scan.upload'));

    await s.pick('t');
    $(s.el, '[data-action="use-photo"]').click();
    await settle();
    expect(s.el.dataset.step).toBe('underside');
    await s.pick('uu');
    expect(s.el.querySelector('[data-crop-check="underside"] h2')?.textContent).toBe(t('scan.checkUndersideTitle'));
    $(s.el, '[data-action="crop-retake"]').click();
    expect(s.el.dataset.step).toBe('underside');
    expect(s.ctx.capture.current()?.underside).toBeUndefined();
    expect(s.calls).toEqual([]);

    // A crop that fails (e.g. no WebP encoder) keeps the check open with the photo's error.
    const failing = check([]);
    await settle();
    failing.deps.crop.mockRejectedValueOnce(new Error('webp'));
    $(failing.el, '[data-action="use-photo"]').click();
    await settle();
    expect(failing.el.querySelector('[role="alert"]')?.textContent).toBe(t('scan.photoFailed'));
    expect($<HTMLButtonElement>(failing.el, '[data-action="use-photo"]').disabled).toBe(false);
  });

  it('[T-app-176] the underside gets the same check; a pocket scan keeps its target through both', async () => {
    const s = await scan('A·3·17');
    await s.pick('t');
    expect(s.el.querySelector('[data-crop-check="top"]')).not.toBeNull();
    $(s.el, '[data-action="use-photo"]').click();
    await settle();
    await s.pick('uu');
    expect(s.el.querySelector('[data-crop-check="underside"]')).not.toBeNull();
    $(s.el, '[data-action="use-photo"]').click();
    await settle();
    expect(s.deps.crop).toHaveBeenCalledTimes(2);
    expect(s.calls.map((c) => c.path)).toEqual(['/uploads', '/uploads', '/scans/analyse']);
    expect(s.calls[2]?.body).toMatchObject({
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      targetLocationCode: 'A·3·17',
    });
    expect(s.ctx.navigate).toHaveBeenCalledWith('/scan/review');
  });

  it('[T-app-177] flow.shoot receives the cropped CapPhoto; the Scan screen no longer uses the blind centre crop', async () => {
    const s = await scan();
    await s.pick('t');
    $(s.el, '[data-action="use-photo"]').click();
    await settle();
    const cropped = (await s.deps.crop.mock.results[0]?.value) as CapPhoto;
    expect(s.ctx.capture.current()?.top?.photo).toBe(cropped);
    const source = readFileSync(join(SRC, 'screens', 'scan-screen.ts'), 'utf8');
    const flow = readFileSync(join(SRC, 'capture', 'flow.ts'), 'utf8');
    expect(source).not.toMatch(/resizeToWebp/);
    expect(flow).not.toMatch(/prepare\(/);
  });
});
