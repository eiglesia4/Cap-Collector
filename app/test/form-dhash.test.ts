// Form photos send their dHash (CAP-93; ADR-004; architect decision in the CAP-92 review): a photo picked in the form
// (through the crop check) is posted with its `dhash` / `dhashUnderside`, an edit that replaces a side patches that
// side's hash, an edit that leaves the photos alone sends none, and a scan's review keeps the scan's hashes unless its
// photo is replaced. Codec, detector and cropper are fakes (happy-dom has no canvas).
import { Cap } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { CaptureSession } from '../src/capture/context';
import type { AppContext } from '../src/context';
import type { CapPhoto } from '../src/images/resize';
import { CapForm, pickedFields, type CapFormOptions } from '../src/screens/cap-form-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakeCropCheck, fakePlatform, flush, shellContext } from './support/fakes';

const TOP_HASH = 'f0f0f03030f0f0f0';
const UNDER_HASH = '866796a6a6966796';
const SCAN_TOP_HASH = '0123456789abcdef';
const SCAN_ID = ulid(93);
/** A pre-assigned pocket, so Save skips the placement proposal. */
const POCKET = { kind: 'album', album: 'A', sheet: 3, pocket: 17 } as const;

const photo = (dhash: string): CapPhoto => ({
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash,
});
const keyOf = (side: string) => `u1/${SCAN_ID}/${side}-picked.webp`;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

async function form(options: Omit<CapFormOptions, 'check' | 'put'>, answer: (path: string, method: string) => unknown) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    const body = (opts.body ?? {}) as Record<string, unknown>;
    calls.push({ path, method, body });
    const reply =
      path === '/uploads'
        ? { key: keyOf(String(body.side)), url: 'https://s3.test/put', expiresAt: '2030-01-01T00:00:00.000Z' }
        : answer(path, method);
    const parsed = opts.schema.safeParse(reply);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform('web');
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  // The cropped photo's hash follows the picked file's name: top.jpg → TOP_HASH, under.jpg → UNDER_HASH.
  const check = fakeCropCheck((file) => photo((file as File).name === 'under.jpg' ? UNDER_HASH : TOP_HASH));
  const el = CapForm(ctx, { ...options, check, put: async () => new Response(null, { status: 200 }) });
  document.body.replaceChildren(el);
  const add = async (side: 'top' | 'underside') => {
    vi.mocked(platform.pickFiles).mockResolvedValueOnce([new File(['x'], side === 'top' ? 'top.jpg' : 'under.jpg')]);
    $(el, `[data-pick="${side}:library"]`).click();
    await settle();
    $(el, '[data-action="use-photo"]').click();
    await settle();
  };
  const set = (field: string, value: string) => {
    const input = $<HTMLInputElement>(el, `#cap-${field}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const save = async () => {
    $<HTMLFormElement>(el, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const sent = (method: string) => calls.find((c) => c.path.startsWith('/caps') && c.method === method)?.body;
  return { el, add, set, save, sent };
}

const created = (_path: string, method: string) => (method === 'POST' ? wireCap(7) : undefined);

afterEach(() => document.body.replaceChildren());

describe('form photos carry their dHash', () => {
  it('[T-app-181] a manual cap posts dhash and dhashUnderside of the cropped photos', async () => {
    const m = await form({ mode: 'empty' }, created);
    m.set('brand', 'Daura');
    await m.add('top');
    await m.add('underside');
    await m.save();
    expect(m.sent('POST')).toMatchObject({
      brand: 'Daura',
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      images: { top: { key: keyOf('top') }, underside: { key: keyOf('underside') } },
    });

    // Only the hash of a photo still attached counts.
    expect(pickedFields({ top: { key: 'a', dhash: TOP_HASH } }, { top: { key: 'b', width: 1, height: 1 } })).toEqual(
      {},
    );
  });

  it('[T-app-182] edit: replacing the top photo patches dhash; leaving the photos alone sends no hash', async () => {
    const cap = Cap.parse(wireCap(3, { brand: 'Mahou', dhash: SCAN_TOP_HASH }));
    const patched = (_path: string, method: string) => (method === 'PATCH' ? wireCap(3) : undefined);

    const replaced = await form({ mode: 'edit', cap }, patched);
    await replaced.add('top');
    await replaced.save();
    const patch = replaced.sent('PATCH');
    expect(patch).toMatchObject({ dhash: TOP_HASH, images: { top: { key: keyOf('top') } } });
    expect(patch).not.toHaveProperty('dhashUnderside');

    const untouched = await form({ mode: 'edit', cap }, patched);
    untouched.set('variant', 'Especial');
    await untouched.save();
    const plain = untouched.sent('PATCH');
    expect(plain).toMatchObject({ variant: 'Especial' });
    expect(plain).not.toHaveProperty('dhash');
    expect(plain).not.toHaveProperty('dhashUnderside');
  });

  it('[T-app-183] a scan review keeps the scan hashes; a photo replaced in the review takes its new hash', async () => {
    const scan = (): CaptureSession => ({
      scanId: SCAN_ID,
      useAi: true,
      top: { photo: photo(SCAN_TOP_HASH), ref: { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024 } },
      response: { scanId: SCAN_ID, outcome: 'identified', fields: { brand: 'Ambar' }, suggestions: [], aiModel: 'm' },
    });
    const kept = await form({ mode: 'ai-prefilled', scan: scan(), location: POCKET }, created);
    await kept.save();
    expect(kept.sent('POST')).toMatchObject({ dhash: SCAN_TOP_HASH });

    const swapped = await form({ mode: 'ai-prefilled', scan: scan(), location: POCKET }, created);
    await swapped.add('top');
    await swapped.save();
    expect(swapped.sent('POST')).toMatchObject({ dhash: TOP_HASH, images: { top: { key: keyOf('top') } } });
  });
});
