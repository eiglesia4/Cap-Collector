// Tests for the Platform adapter: startup selection, web implementation, Capacitor implementation (CAP-21, ADR-001).
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ value: false }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => native.value } };
});

import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import { isCancel } from '../src/platform/platform';
import { selectPlatform } from '../src/platform/select-platform';
import { createWebPlatform, createWebStore } from '../src/platform/web/web-platform';
import { fakePlatform } from './support/fakes';

afterEach(() => {
  native.value = false;
  vi.restoreAllMocks();
});

/** Make the next file input created by the platform answer with `files` (or a cancel when null). */
function answerFileInput(files: File[] | null): { input: () => HTMLInputElement } {
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (files === null) {
      this.dispatchEvent(new Event('cancel'));
      return;
    }
    Object.defineProperty(this, 'files', { value: files, configurable: true });
    this.dispatchEvent(new Event('change'));
  });
  return {
    input: () => {
      const created = click.mock.contexts.at(-1);
      if (!(created instanceof HTMLInputElement)) throw new Error('no input created');
      return created;
    },
  };
}

describe('platform selection', () => {
  it('[T-app-003] picks the web adapter in the browser and the Capacitor adapter when Capacitor.isNativePlatform()', async () => {
    native.value = false;
    expect((await selectPlatform(window)).kind).toBe('web');
    native.value = true;
    const platform = await selectPlatform(window);
    expect(platform.kind).toBe('native');
    expect(typeof platform.store.get).toBe('function');
  });
});

describe('web platform', () => {
  it('[T-app-009] uses file inputs for camera and pick, Web Share when available, localStorage with a memory fallback', async () => {
    const web = createWebPlatform(window);
    const photo = new File(['x'], 'cap.jpg', { type: 'image/jpeg' });

    const cam = answerFileInput([photo]);
    expect(await web.camera()).toBe(photo);
    expect(cam.input().accept).toBe('image/*');
    expect(cam.input().getAttribute('capture')).toBe('environment');

    answerFileInput(null);
    expect(await web.camera()).toBeNull();

    const pick = answerFileInput([photo, photo]);
    expect(await web.pickFiles({ accept: '.json', multiple: true })).toHaveLength(2);
    expect(pick.input().accept).toBe('.json');
    expect(pick.input().multiple).toBe(true);
    const def = answerFileInput([photo]);
    await web.pickFiles();
    expect(def.input().accept).toBe('image/*');

    // Share: unavailable → false; ok → true; cancelled → false; files not shareable → false; other errors propagate.
    const nav = window.navigator as Navigator & { share?: unknown; canShare?: unknown };
    Object.defineProperty(nav, 'share', { value: undefined, configurable: true });
    expect(await web.share({ text: 'x' })).toBe(false);
    const share = vi.fn(async () => undefined);
    Object.defineProperty(nav, 'share', { value: share, configurable: true });
    Object.defineProperty(nav, 'canShare', { value: () => true, configurable: true });
    expect(await web.share({ title: 'T', text: 'x', url: 'https://a.test', files: [photo] })).toBe(true);
    expect(share).toHaveBeenCalledWith({ title: 'T', text: 'x', url: 'https://a.test', files: [photo] });
    share.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await web.share({ text: 'x' })).toBe(false);
    share.mockRejectedValueOnce(new Error('boom'));
    await expect(web.share({ text: 'x' })).rejects.toThrow('boom');
    Object.defineProperty(nav, 'canShare', { value: () => false, configurable: true });
    expect(await web.share({ files: [photo] })).toBe(false);

    // Store: localStorage round trip, then a blocked storage keeps working from memory.
    await web.store.set('k', 'v');
    expect(window.localStorage.getItem('k')).toBe('v');
    expect(await web.store.get('k')).toBe('v');
    await web.store.remove('k');
    expect(await web.store.get('k')).toBeNull();

    const blocked = {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    };
    const memory = createWebStore(blocked as unknown as Window);
    await memory.set('a', '1');
    expect(await memory.get('a')).toBe('1');
    await memory.remove('a');
    expect(await memory.get('a')).toBeNull();

    const throwing = {
      localStorage: {
        getItem: () => {
          throw new Error('x');
        },
        setItem: () => {
          throw new Error('QuotaExceeded');
        },
        removeItem: () => {
          throw new Error('x');
        },
      },
    };
    const full = createWebStore(throwing as unknown as Window);
    await full.set('b', '2');
    expect(await full.get('b')).toBe('2');
    await full.remove('b');
    expect(await full.get('b')).toBeNull();
  });
});

describe('capacitor platform', () => {
  function plugins(): CapacitorPlugins & { prefs: Map<string, string> } {
    const prefs = new Map<string, string>();
    return {
      prefs,
      Camera: {
        takePhoto: vi.fn(async () => ({
          type: 0,
          saved: false,
          webPath: 'capacitor://localhost/_capacitor_file_/p.jpg',
        })),
        chooseFromGallery: vi.fn(async () => ({
          results: [
            { type: 0, saved: false, webPath: 'capacitor://a.jpg' },
            { type: 0, saved: false },
          ],
        })),
      } as unknown as CapacitorPlugins['Camera'],
      Share: { share: vi.fn(async () => ({})) },
      Filesystem: {
        writeFile: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` })),
      } as unknown as CapacitorPlugins['Filesystem'],
      Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value)),
        remove: vi.fn(async ({ key }: { key: string }) => void prefs.delete(key)),
      },
      fetch: vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }))),
    };
  }

  it('[T-app-010] maps camera, gallery, share and store onto Camera, Filesystem, Share and Preferences', async () => {
    const p = plugins();
    const fallback = fakePlatform('web');
    const cap = createCapacitorPlatform(fallback, p);
    expect(cap.kind).toBe('native');

    const photo = await cap.camera();
    expect(photo).toBeInstanceOf(File);
    expect(photo?.type).toBe('image/png');
    expect(p.fetch).toHaveBeenCalledWith('capacitor://localhost/_capacitor_file_/p.jpg');

    vi.mocked(p.Camera.takePhoto).mockRejectedValueOnce(new Error('User cancelled photos app'));
    expect(await cap.camera()).toBeNull();
    vi.mocked(p.Camera.takePhoto).mockRejectedValueOnce(new Error('camera broken'));
    await expect(cap.camera()).rejects.toThrow('camera broken');
    vi.mocked(p.Camera.takePhoto).mockResolvedValueOnce({ type: 0, saved: false } as never);
    expect(await cap.camera()).toBeNull();

    // Gallery for images (results without a webPath are skipped); other types go to the web fallback.
    expect(await cap.pickFiles({ multiple: true })).toHaveLength(1);
    expect(p.Camera.chooseFromGallery).toHaveBeenCalledWith({ allowMultipleSelection: true });
    await cap.pickFiles({ accept: 'image/png, image/jpeg' });
    expect(p.Camera.chooseFromGallery).toHaveBeenLastCalledWith({ allowMultipleSelection: false });
    await cap.pickFiles({ accept: '.json,application/json' });
    expect(fallback.pickFiles).toHaveBeenCalledWith({ accept: '.json,application/json' });
    vi.mocked(p.Camera.chooseFromGallery).mockRejectedValueOnce(new Error('User cancelled'));
    expect(await cap.pickFiles()).toEqual([]);
    vi.mocked(p.Camera.chooseFromGallery).mockRejectedValueOnce(new Error('denied'));
    await expect(cap.pickFiles()).rejects.toThrow('denied');

    // Share writes files to the cache directory and passes their URIs.
    const file = new File(['hello'], 'request.zip', { type: 'application/zip' });
    expect(await cap.share({ title: 'T', text: 'x', url: 'https://a.test', files: [file] })).toBe(true);
    expect(p.Filesystem.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'share/request.zip', data: btoa('hello'), recursive: true }),
    );
    expect(p.Share.share).toHaveBeenCalledWith({
      title: 'T',
      text: 'x',
      url: 'https://a.test',
      files: ['file:///cache/share/request.zip'],
    });
    await cap.share({ text: 'only text' });
    expect(p.Share.share).toHaveBeenLastCalledWith({ text: 'only text' });
    vi.mocked(p.Share.share).mockRejectedValueOnce(new Error('Share canceled'));
    expect(await cap.share({ text: 'x' })).toBe(false);
    vi.mocked(p.Share.share).mockRejectedValueOnce(new Error('nope'));
    await expect(cap.share({ text: 'x' })).rejects.toThrow('nope');

    await cap.store.set('k', 'v');
    expect(await cap.store.get('k')).toBe('v');
    await cap.store.remove('k');
    expect(await cap.store.get('k')).toBeNull();

    expect(isCancel('user cancelled')).toBe(true);
    expect(isCancel(new Error('other'))).toBe(false);
  });
});
