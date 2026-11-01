// Capacitor (iPhone) implementation of the Platform adapter: Camera, Share, Filesystem, Preferences — ADR-001.
// Non-image file picks (e.g. an Exchange answer JSON) fall back to the web <input type=file>, which WKWebView
// presents with the Files app.
import { Camera } from '@capacitor/camera';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';

import { isCancel, type PickOptions, type Platform, type ShareRequest } from '../platform.js';

export interface CapacitorPlugins {
  readonly Camera: Pick<typeof Camera, 'takePhoto' | 'chooseFromGallery'>;
  readonly Share: Pick<typeof Share, 'share'>;
  readonly Filesystem: Pick<typeof Filesystem, 'writeFile'>;
  readonly Preferences: Pick<typeof Preferences, 'get' | 'set' | 'remove'>;
  /** Reads a plugin `webPath` into a Blob. */
  readonly fetch: (input: string) => Promise<Response>;
}

const defaultPlugins = (): CapacitorPlugins => ({
  Camera,
  Share,
  Filesystem,
  Preferences,
  fetch: (input) => fetch(input),
});

function isImageAccept(accept: string | undefined): boolean {
  return accept === undefined || accept.split(',').every((a) => a.trim().startsWith('image/'));
}

async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createCapacitorPlatform(fallback: Platform, plugins: CapacitorPlugins = defaultPlugins()): Platform {
  async function fileFrom(webPath: string | undefined, name: string): Promise<File | null> {
    if (!webPath) return null;
    const blob = await (await plugins.fetch(webPath)).blob();
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  return {
    kind: 'native',
    async camera() {
      try {
        const result = await plugins.Camera.takePhoto({ quality: 90, correctOrientation: true });
        return await fileFrom(result.webPath, `photo-${Date.now()}.jpg`);
      } catch (error) {
        if (isCancel(error)) return null;
        throw error;
      }
    },
    async pickFiles(options: PickOptions = {}) {
      if (!isImageAccept(options.accept)) return fallback.pickFiles(options);
      try {
        const { results } = await plugins.Camera.chooseFromGallery({
          allowMultipleSelection: options.multiple ?? false,
        });
        const files = await Promise.all(results.map((r, i) => fileFrom(r.webPath, `photo-${Date.now()}-${i}.jpg`)));
        return files.filter((f): f is File => f !== null);
      } catch (error) {
        if (isCancel(error)) return [];
        throw error;
      }
    },
    async share(request: ShareRequest) {
      try {
        const files: string[] = [];
        for (const file of request.files ?? []) {
          const written = await plugins.Filesystem.writeFile({
            path: `share/${file.name}`,
            data: await toBase64(file),
            directory: Directory.Cache,
            recursive: true,
          });
          files.push(written.uri);
        }
        await plugins.Share.share({
          ...(request.title !== undefined && { title: request.title }),
          ...(request.text !== undefined && { text: request.text }),
          ...(request.url !== undefined && { url: request.url }),
          ...(files.length > 0 && { files }),
        });
        return true;
      } catch (error) {
        if (isCancel(error)) return false;
        throw error;
      }
    },
    store: {
      async get(key) {
        return (await plugins.Preferences.get({ key })).value;
      },
      async set(key, value) {
        await plugins.Preferences.set({ key, value });
      },
      async remove(key) {
        await plugins.Preferences.remove({ key });
      },
    },
  };
}
