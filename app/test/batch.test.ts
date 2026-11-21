// Batch mode, part 2 (CAP-83; SCREENS.md § Batch mode; ADR-009 §1–2, §5; ADR-001): the Scan tab's Single · Batch
// switch, Tray adjust over a stubbed `detectCaps` (numbered circles, remove / add / move / resize with renumbering in
// reading order, the 30 limit, the zero-caps state), Start cropping every circle from the full-resolution photo into the
// on-device batch store (no tray photo kept), the unfinished-batch prompt, and "Upload tray photo" on the web.
import { describe, expect, it, vi } from 'vitest';

import { SCAN_MODE_KEY } from '../src/batch/context';
import { indexedDbBatchStore, memoryBatchStore, type Batch } from '../src/batch/store';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { Crop, DecodedImage, Raster, RasterCodec } from '../src/images/resize';
import { matchRoute } from '../src/router/routes';
import { BatchScreen } from '../src/screens/batch-screen';
import { ScanView } from '../src/screens/scan-screen';
import { TrayAdjustView } from '../src/screens/tray-adjust-screen';
import type { DetectedCircle, Detection } from '../src/vision/segment';
import { fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const BATCH_ID = '01JBF70A1B2C3D4E0000000BAT';
const NOW = new Date('2026-11-21T20:00:00.000Z');

async function context(kind: 'web' | 'native' = 'native', store = memoryStore()) {
  const ctx: AppContext = {
    ...(await shellContext({ platform: fakePlatform(kind, store) })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
    now: () => NOW,
  };
  return ctx;
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

/** A 4000 × 3000 "photo": the codec records every crop it is asked to draw. */
function fakeCodec() {
  const crops: { crop: Crop; width: number; height: number }[] = [];
  const close = vi.fn();
  const codec: RasterCodec = {
    decode: vi.fn(async (): Promise<DecodedImage> => ({
      source: document.createElement('canvas'),
      width: 4000,
      height: 3000,
      close,
    })),
    encode: vi.fn(),
    raster: vi.fn(async (_image, crop, width, height): Promise<Raster> => {
      crops.push({ crop, width, height });
      return { data: new Uint8ClampedArray(width * height * 4).fill(128), width, height };
    }),
    encodeRaster: vi.fn(async () => new Blob([new Uint8Array(10)], { type: 'image/webp' })),
  };
  return { codec, crops, close };
}

const circle = (cx: number, cy: number, r = 40, uncertain = false): DetectedCircle => ({ cx, cy, r, uncertain });

/** Two rows, in reading order (detection pixels on the 1600 × 1200 raster; scale 2.5 to the photo). */
const DETECTED = [circle(100, 100), circle(300, 104), circle(500, 98, 40, true), circle(120, 300), circle(320, 302)];

function stubDetect(circles: readonly DetectedCircle[], extra: Partial<Detection> = {}) {
  return vi.fn((_pixels: unknown, opts: { sourceWidth?: number } = {}): Detection => ({
    circles,
    medianRadius: 40,
    scale: (opts.sourceWidth ?? 1600) / 1600,
    truncated: false,
    ...extra,
  }));
}

async function adjust(circles: readonly DetectedCircle[] = DETECTED, extra: Partial<Detection> = {}) {
  const ctx = await context();
  ctx.batch.tray.set(new Blob(['tray'], { type: 'image/jpeg' }));
  const { codec, crops, close } = fakeCodec();
  const detect = stubDetect(circles, extra);
  const el = TrayAdjustView(ctx, { codec, detect, newId: () => BATCH_ID });
  document.body.replaceChildren(el);
  await settle();
  return { ctx, el, codec, crops, close, detect };
}

/** Circle number → its centre, in drawing order. */
const drawn = (el: HTMLElement) =>
  [...el.querySelectorAll<SVGGElement>('.tray-circle')].map((g) => {
    const c = g.querySelector('circle');
    return {
      n: g.querySelector('text')?.textContent,
      cx: Number(c?.getAttribute('cx')),
      cy: Number(c?.getAttribute('cy')),
      r: Number(c?.getAttribute('r')),
      dashed: c?.hasAttribute('stroke-dasharray') ?? false,
      selected: g.hasAttribute('data-selected'),
    };
  });

/** A pointer event at detection coordinates (happy-dom lays nothing out, so client = viewBox pixels). */
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
}

const overlay = (el: HTMLElement) => el.querySelector<SVGSVGElement>('.tray-overlay')!;
const circleEl = (el: HTMLElement, n: number) => el.querySelector(`.tray-circle[data-index="${String(n)}"] circle`)!;
const count = (el: HTMLElement) => el.querySelector('[data-count]')?.textContent;

describe('scan: Single · Batch', () => {
  it('[T-app-140] the Single · Batch switch is remembered in the platform store and shows the batch hint', async () => {
    const store = memoryStore();
    const ctx = await context('native', store);
    const first = ScanView(ctx);
    document.body.replaceChildren(first);
    await settle();
    expect(first.dataset.mode).toBe('single');
    expect(first.querySelector('[data-mode="single"]')?.getAttribute('aria-pressed')).toBe('true');
    first.querySelector<HTMLButtonElement>('[data-mode="batch"]')?.click();
    await settle();
    expect(store.data.get(SCAN_MODE_KEY)).toBe('batch');
    expect(first.dataset.mode).toBe('batch');
    expect(first.querySelector('[data-hint="batch"]')?.textContent).toBe(t('scan.batchHint'));
    expect(first.querySelector('[data-action="manual"]')).toBeNull();

    // Opening Scan again: batch is remembered.
    const again = ScanView(await context('native', store));
    document.body.replaceChildren(again);
    await settle();
    expect(again.dataset.mode).toBe('batch');
    expect(again.querySelector('[data-mode="batch"]')?.getAttribute('aria-pressed')).toBe('true');
    again.querySelector<HTMLButtonElement>('[data-mode="single"]')?.click();
    await settle();
    expect(store.data.get(SCAN_MODE_KEY)).toBe('single');
    expect(again.querySelector('[data-action="shoot"]')).not.toBeNull();

    // A scan pre-assigned to a pocket has no batch switch.
    const pocket = ScanView(await context('native', store), { targetLocationCode: 'A·3·17' });
    expect(pocket.querySelector('.scan-mode')).toBeNull();
  });

  it('[T-app-147] batch on the web reads "Upload tray photo" (no camera); on the iPhone the tray is shot and handed to Tray adjust', async () => {
    const web = await context('web', memoryStore({ [SCAN_MODE_KEY]: 'batch' }));
    const tray = new File(['tray'], 'tray.jpg', { type: 'image/jpeg' });
    vi.mocked(web.platform.pickFiles).mockResolvedValue([tray]);
    const webView = ScanView(web);
    document.body.replaceChildren(webView);
    await settle();
    const upload = webView.querySelector<HTMLButtonElement>('[data-action="upload-tray"]');
    expect(upload?.textContent).toBe(t('scan.uploadTray'));
    expect(webView.querySelector('[data-action="shoot-tray"]')).toBeNull();
    upload?.click();
    await settle();
    expect(web.platform.camera).not.toHaveBeenCalled();
    expect(web.batch.tray.current()).toBe(tray);
    expect(web.navigate).toHaveBeenCalledWith('/scan/batch/adjust');
    expect(matchRoute('/scan/batch/adjust')?.route).toMatchObject({ name: 'scanBatchAdjust', modal: true });

    const phone = await context('native', memoryStore({ [SCAN_MODE_KEY]: 'batch' }));
    vi.mocked(phone.platform.camera).mockResolvedValue(tray);
    const phoneView = ScanView(phone);
    document.body.replaceChildren(phoneView);
    await settle();
    expect(phoneView.querySelector('[data-action="library-tray"]')).not.toBeNull();
    phoneView.querySelector<HTMLButtonElement>('[data-action="shoot-tray"]')?.click();
    await settle();
    expect(phone.platform.camera).toHaveBeenCalledTimes(1);
    expect(phone.batch.tray.current()).toBe(tray);
    // A cancelled camera does nothing.
    vi.mocked(phone.platform.camera).mockResolvedValue(null);
    phone.batch.tray.clear();
    phoneView.querySelector<HTMLButtonElement>('[data-action="shoot-tray"]')?.click();
    await settle();
    expect(phone.batch.tray.current()).toBeNull();
  });

  it('[T-app-146] with an unfinished batch, Batch asks first: continue it, or discard it and start another', async () => {
    const ctx = await context('native', memoryStore({ [SCAN_MODE_KEY]: 'batch' }));
    const existing: Batch = {
      batchId: BATCH_ID,
      createdAt: NOW.toISOString(),
      placeAsYouGo: false,
      items: [0, 1, 2].map((index) => ({
        index,
        photo: new Blob(['x']),
        dhash: '0123456789abcdef',
        width: 200,
        height: 200,
        state: 'waiting' as const,
      })),
    };
    await ctx.batch.store.save(existing);
    const view = ScanView(ctx);
    document.body.replaceChildren(view);
    await settle();
    const prompt = view.querySelector('[data-sheet="unfinished-batch"]');
    expect(prompt?.textContent).toContain(t('scan.batchUnfinished', { count: 3 }));
    expect(view.querySelector('[data-action="shoot-tray"]')).toBeNull();
    view.querySelector<HTMLButtonElement>('[data-action="continue-batch"]')?.click();
    expect(ctx.navigate).toHaveBeenCalledWith('/scan/batch');

    view.querySelector<HTMLButtonElement>('[data-action="discard-batch"]')?.click();
    await settle();
    expect(await ctx.batch.store.current()).toBeNull();
    expect(view.querySelector('[data-sheet="unfinished-batch"]')).toBeNull();
    expect(view.querySelector('[data-action="shoot-tray"]')).not.toBeNull();
  });
});

describe('tray adjust', () => {
  it('[T-app-141] detects on a ≤ 1600 px copy and draws one numbered circle per cap in reading order, uncertain ones dashed', async () => {
    const { el, crops, detect } = await adjust();
    // The 4000 × 3000 photo drawn once at 1600 × 1200 for detection; scale back to the photo = 2.5.
    expect(crops).toEqual([{ crop: { sx: 0, sy: 0, sw: 4000, sh: 3000 }, width: 1600, height: 1200 }]);
    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ width: 1600, height: 1200 }), { sourceWidth: 4000 });
    expect(overlay(el).getAttribute('viewBox')).toBe('0 0 1600 1200');
    expect(drawn(el).map((c) => [c.n, c.cx, c.cy, c.dashed])).toEqual([
      ['1', 100, 100, false],
      ['2', 300, 104, false],
      ['3', 500, 98, true],
      ['4', 120, 300, false],
      ['5', 320, 302, false],
    ]);
    expect(count(el)).toBe(t('batch.count', { count: 5 }));
    expect(el.querySelector('[data-action="start"]')?.textContent).toBe(t('batch.start', { count: 5 }));
    expect(el.querySelector<HTMLElement>('.tray-editor')?.hidden).toBe(true);
    expect(el.querySelector<HTMLInputElement>('input[name="place-as-you-go"]')?.checked).toBe(false);
  });

  it('[T-app-142] select, move, resize, remove and add: every edit renumbers in reading order', async () => {
    const { el } = await adjust();
    // Select 2 and drag it to the second row, right of 5 → it becomes the last one.
    pointer(circleEl(el, 1), 'pointerdown', 300, 104);
    expect(drawn(el)[1]?.selected).toBe(true);
    expect(el.querySelector<HTMLElement>('.tray-editor')?.hidden).toBe(false);
    pointer(overlay(el), 'pointermove', 520, 300);
    pointer(overlay(el), 'pointerup', 520, 300);
    expect(drawn(el).map((c) => [c.n, c.cx, c.cy])).toEqual([
      ['1', 100, 100],
      ['2', 500, 98],
      ['3', 120, 300],
      ['4', 320, 302],
      ['5', 520, 300],
    ]);
    // The moved one is still selected; the slider resizes it.
    const slider = el.querySelector<HTMLInputElement>('[data-action="size"]')!;
    expect(slider.value).toBe('40');
    slider.value = '50';
    slider.dispatchEvent(new Event('input'));
    expect(drawn(el)[4]?.r).toBe(50);
    // …and so does the corner handle.
    pointer(el.querySelector('[data-handle]')!, 'pointerdown', 555, 335);
    pointer(overlay(el), 'pointermove', 520, 360);
    pointer(overlay(el), 'pointerup', 520, 360);
    expect(drawn(el)[4]?.r).toBe(60);
    // Nudging the uncertain one (now number 2) makes it certain.
    expect(drawn(el)[1]?.dashed).toBe(true);
    pointer(circleEl(el, 1), 'pointerdown', 500, 98);
    pointer(overlay(el), 'pointermove', 502, 98);
    pointer(overlay(el), 'pointerup', 502, 98);
    expect(drawn(el)[1]).toMatchObject({ cx: 502, dashed: false });
    // A tap on an empty spot adds a circle at the median size, selected, numbered in reading order.
    pointer(overlay(el), 'pointerdown', 0, 0);
    expect(drawn(el)).toHaveLength(6);
    expect(drawn(el)[0]).toMatchObject({ n: '1', cx: 0, cy: 0, r: 40, selected: true });

    // Remove the selected (new) one, then 1 → the rest renumber.
    el.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    pointer(circleEl(el, 0), 'pointerdown', 100, 100);
    pointer(overlay(el), 'pointerup', 100, 100);
    el.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    expect(drawn(el).map((c) => [c.n, c.cx])).toEqual([
      ['1', 502],
      ['2', 120],
      ['3', 320],
      ['4', 520],
    ]);
    expect(count(el)).toBe(t('batch.count', { count: 4 }));
    // Tap an empty spot on row 1 between the others → added at the median size, numbered in place.
    pointer(overlay(el), 'pointerdown', 250, 100);
    expect(drawn(el).map((c) => [c.n, c.cx, c.r])).toEqual([
      ['1', 250, 40],
      ['2', 502, 40],
      ['3', 120, 40],
      ['4', 320, 40],
      ['5', 520, 60],
    ]);
  });

  it('[T-app-143] at most 30 circles: adding a 31st is refused with a message; more than 30 detected says so', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => circle(60 + (i % 10) * 150, 80 + Math.floor(i / 10) * 200));
    const full = await adjust(thirty);
    expect(drawn(full.el)).toHaveLength(30);
    pointer(overlay(full.el), 'pointerdown', 800, 1000);
    expect(drawn(full.el)).toHaveLength(30);
    expect(full.el.querySelector('[data-status]')?.textContent).toBe(t('batch.limit', { max: 30 }));

    const truncated = await adjust(thirty, { truncated: true });
    expect(truncated.el.querySelector('[data-status]')?.textContent).toBe(t('batch.truncated', { max: 30 }));
  });

  it('[T-app-144] zero caps found: the empty state with Retake and Add by hand', async () => {
    const { el } = await adjust([]);
    expect(el.querySelector('[data-empty]')?.textContent).toBe(t('batch.noneFound'));
    expect(count(el)).toBe(t('batch.count', { count: 0 }));
    el.querySelector<HTMLButtonElement>('[data-action="add-by-hand"]')?.click();
    expect(el.querySelector<HTMLButtonElement>('[data-action="start"]')?.disabled).toBe(true);
    pointer(overlay(el), 'pointerdown', 400, 300);
    expect(drawn(el)).toEqual([expect.objectContaining({ n: '1', cx: 400, cy: 300, r: 40 })]);
    expect(el.querySelector<HTMLButtonElement>('[data-action="start"]')?.disabled).toBe(false);

    // Retake drops the tray photo and goes back to Scan.
    const again = await adjust([]);
    again.el.querySelector<HTMLButtonElement>('[data-action="retake-empty"]')?.click();
    expect(again.ctx.batch.tray.current()).toBeNull();
    expect(again.ctx.navigate).toHaveBeenCalledWith('/scan');

    // Reached without a tray photo (reload): says so.
    const bare = await context();
    const lost = TrayAdjustView(bare, { codec: fakeCodec().codec, detect: stubDetect([]) });
    await settle();
    expect(lost.querySelector('[role="alert"]')?.textContent).toBe(t('batch.noTray'));
  });

  it('[T-app-145] Start crops every circle from the full-resolution photo, stores the batch (no tray photo) and opens it', async () => {
    const { el, ctx, crops, close } = await adjust(DETECTED.slice(0, 3));
    el.querySelector<HTMLInputElement>('input[name="place-as-you-go"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-action="start"]')?.click();
    await settle();
    // After the detection draw: one crop per circle, at 2.5 × the detection coordinates + 6 % margin.
    expect(crops.slice(1).map((c) => c.crop)).toEqual([
      { sx: 144, sy: 144, sw: 212, sh: 212 },
      { sx: 644, sy: 154, sw: 212, sh: 212 },
      { sx: 1144, sy: 139, sw: 212, sh: 212 },
    ]);
    const batch = await ctx.batch.store.current();
    expect(batch).toMatchObject({ batchId: BATCH_ID, createdAt: NOW.toISOString(), placeAsYouGo: true });
    expect(batch?.items.map((i) => [i.index, i.state, i.width, i.dhash.length])).toEqual([
      [0, 'waiting', 212, 16],
      [1, 'waiting', 212, 16],
      [2, 'waiting', 212, 16],
    ]);
    expect(batch?.items.every((i) => i.photo.type === 'image/webp')).toBe(true);
    // The tray photo is not kept anywhere (ADR-009 §2).
    expect(Object.keys(batch ?? {}).sort()).toEqual(['batchId', 'createdAt', 'items', 'placeAsYouGo']);
    expect(ctx.batch.tray.current()).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(ctx.navigate).toHaveBeenCalledWith('/scan/batch');

    // The interim batch screen lists the crops and discards the batch.
    const list = BatchScreen(ctx, matchRoute('/scan/batch')!);
    document.body.replaceChildren(list);
    await settle();
    expect(list.querySelector('h1')?.textContent).toBe(t('batch.titleCount', { count: 3 }));
    expect([...list.querySelectorAll('.batch-number')].map((n) => n.textContent)).toEqual(['1', '2', '3']);
    list.querySelector<HTMLButtonElement>('[data-action="discard-batch"]')?.click();
    await settle();
    expect(await ctx.batch.store.current()).toBeNull();
    expect(ctx.navigate).toHaveBeenLastCalledWith('/scan');
    const empty = BatchScreen(ctx, matchRoute('/scan/batch')!);
    await settle();
    expect(empty.textContent).toContain(t('batch.none'));

    // A failing crop keeps the user on the adjust screen with a message, and stores nothing.
    const failing = await adjust(DETECTED.slice(0, 1));
    vi.mocked(failing.codec.encodeRaster).mockResolvedValue(null);
    failing.el.querySelector<HTMLButtonElement>('[data-action="start"]')?.click();
    await settle();
    expect(failing.el.querySelector('[data-status]')?.textContent).toBe(t('batch.cropFailed'));
    expect(await failing.ctx.batch.store.current()).toBeNull();
    expect(failing.el.querySelector<HTMLButtonElement>('[data-action="start"]')?.disabled).toBe(false);
  });
});

describe('batch store', () => {
  it('[T-app-148] the memory store keeps one unfinished batch: save replaces, discard forgets', async () => {
    const store = memoryBatchStore();
    expect(await store.current()).toBeNull();
    const batch = (id: string): Batch => ({
      batchId: id,
      createdAt: NOW.toISOString(),
      placeAsYouGo: false,
      items: [],
    });
    await store.save(batch('A'));
    await store.save(batch('B'));
    expect((await store.current())?.batchId).toBe('B');
    await store.discard();
    expect(await store.current()).toBeNull();
  });

  it('[T-app-149] the IndexedDB store opens capcollector/batch once, creates the object store on upgrade, and saves, reads and discards one record', async () => {
    // A minimal IDBFactory: requests resolve on the next tick; one database with Map-backed object stores.
    const stores = new Map<string, Map<string, unknown>>();
    const opened = vi.fn();
    const later = <T>(result: () => T, fail = false) => {
      const req = { result: undefined as T | undefined, error: fail ? new Error('boom') : null } as {
        result?: T;
        error: Error | null;
        onsuccess?: () => void;
        onerror?: () => void;
      };
      setTimeout(() => {
        if (fail) return req.onerror?.();
        req.result = result();
        req.onsuccess?.();
      }, 0);
      return req;
    };
    const db = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => stores.set(name, new Map()),
      transaction: (name: string) => ({
        objectStore: () => {
          const map = stores.get(name)!;
          return {
            get: (key: string) => later(() => map.get(key)),
            put: (value: unknown, key: string) => later(() => void map.set(key, value)),
            delete: (key: string) => later(() => void map.delete(key)),
          };
        },
      }),
    };
    const factory = {
      open: (name: string, version: number) => {
        opened(name, version);
        // As in IndexedDB: `upgradeneeded` (first open only) fires before `success`.
        const req: { result?: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
        setTimeout(() => {
          req.result = db;
          if (!stores.has('batch')) req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    } as unknown as IDBFactory;

    const store = indexedDbBatchStore(factory);
    expect(await store.current()).toBeNull();
    const batch: Batch = { batchId: BATCH_ID, createdAt: NOW.toISOString(), placeAsYouGo: false, items: [] };
    await store.save(batch);
    expect(await store.current()).toEqual(batch);
    await store.discard();
    expect(await store.current()).toBeNull();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith('capcollector', 1);
    expect([...stores.keys()]).toEqual(['batch']);

    // A database that cannot open rejects.
    const broken = { open: () => later(() => null, true) } as unknown as IDBFactory;
    await expect(indexedDbBatchStore(broken).current()).rejects.toThrow('boom');
  });
});
