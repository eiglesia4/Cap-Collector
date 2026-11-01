// Browser implementation of the Platform adapter: <input type=file> for camera and files, Web Share API,
// localStorage (with an in-memory fallback when storage is blocked) — ADR-001, CAP-21.
import { isCancel, type KeyValueStore, type PickOptions, type Platform, type ShareRequest } from '../platform.js';

const IMAGES = 'image/*';

export function createWebStore(win: Window): KeyValueStore {
  const memory = new Map<string, string>();
  const storage = (): Storage | null => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  };
  return {
    async get(key) {
      try {
        return storage()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    async set(key, value) {
      memory.set(key, value);
      try {
        storage()?.setItem(key, value);
      } catch {
        // Storage full or blocked (private mode): the in-memory copy keeps this session working.
      }
    },
    async remove(key) {
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        // See set().
      }
    },
  };
}

function chooseFiles(win: Window, accept: string, multiple: boolean, capture?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = win.document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

export function createWebPlatform(win: Window): Platform {
  return {
    kind: 'web',
    async camera() {
      const [file] = await chooseFiles(win, IMAGES, false, 'environment');
      return file ?? null;
    },
    pickFiles(options: PickOptions = {}) {
      return chooseFiles(win, options.accept ?? IMAGES, options.multiple ?? false);
    },
    async share(request: ShareRequest) {
      const nav = win.navigator;
      if (typeof nav.share !== 'function') return false;
      const data: ShareData = {};
      if (request.title !== undefined) data.title = request.title;
      if (request.text !== undefined) data.text = request.text;
      if (request.url !== undefined) data.url = request.url;
      if (request.files?.length) {
        data.files = [...request.files];
        if (typeof nav.canShare === 'function' && !nav.canShare(data)) return false;
      }
      try {
        await nav.share(data);
        return true;
      } catch (error) {
        if (isCancel(error)) return false;
        throw error;
      }
    },
    store: createWebStore(win),
  };
}
