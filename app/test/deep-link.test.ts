// Tests for collectors:// deep links on the iPhone (CAP-33): parsing to the cap route, the platform forwarding
// `appUrlOpen`, and the shell navigating to the cap.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';
import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import type { Platform } from '../src/platform/platform';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { deepLinkPath, handleDeepLinks } from '../src/router/deep-link';
import { ulid } from './support/caps';
import { fakePlatform, shellContext } from './support/fakes';

const ID = ulid(7);

let handle: AppHandle | undefined;
afterEach(() => handle?.destroy());

describe('deep links', () => {
  it('[T-app-062] collectors://cap/<ulid> opens /cap/<ulid>; malformed ids, other hosts and schemes are ignored', async () => {
    expect(deepLinkPath(`collectors://cap/${ID}`)).toBe(`/cap/${ID}`);
    expect(deepLinkPath(`collectors://cap/${ID}/`)).toBe(`/cap/${ID}`);
    expect(deepLinkPath(` COLLECTORS://cap/${ID}?from=card#x `)).toBe(`/cap/${ID}`);
    for (const bad of [
      `collectors://cap/${ID.toLowerCase()}`,
      'collectors://cap/123',
      'collectors://cap/',
      `collectors://cap/${ID}/history`,
      `collectors://album/${ID}`,
      `collectors:/cap/${ID}`,
      `https://caps.naevatec.com/cap/${ID}`,
      `other://cap/${ID}`,
      '',
    ]) {
      expect(deepLinkPath(bad), bad).toBeNull();
    }

    // The handler navigates valid links and drops the rest at debug level, without throwing.
    let emit: (url: string) => void = () => undefined;
    const stop = vi.fn();
    const platform = { onDeepLink: vi.fn((cb: (url: string) => void) => ((emit = cb), stop)) };
    const navigate = vi.fn();
    const debug = vi.fn();
    const unsubscribe = handleDeepLinks(platform, navigate, debug);
    emit(`collectors://cap/${ID}`);
    emit('collectors://settings');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/cap/${ID}`);
    expect(debug).toHaveBeenCalledExactlyOnceWith('deep link ignored');
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    handleDeepLinks(platform, navigate);
    emit('nope');
    expect(consoleDebug).toHaveBeenCalledWith('deep link ignored');
    consoleDebug.mockRestore();

    // Wired into the shell: a link opens the cap detail; destroying the shell unsubscribes.
    window.history.replaceState(null, '', '/');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const shellPlatform: Platform = { ...fakePlatform('native'), onDeepLink: platform.onDeepLink };
    handle = renderApp(root, await shellContext({ platform: shellPlatform }));
    emit(`collectors://cap/${ID}`);
    expect(window.location.pathname).toBe(`/cap/${ID}`);
    expect(handle.router.current().path).toBe(`/cap/${ID}`);
    handle.destroy();
    handle = undefined;
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('[T-app-063] the Capacitor platform forwards appUrlOpen (plugin mocked); the web platform never emits', async () => {
    let fire: (event: { url: string }) => void = () => undefined;
    const remove = vi.fn(async () => undefined);
    const addListener = vi.fn((_name: string, cb: (event: { url: string }) => void) => {
      fire = cb;
      return Promise.resolve({ remove });
    });
    const native = createCapacitorPlatform(fakePlatform('web'), {
      App: { addListener },
    } as unknown as CapacitorPlugins);
    const listener = vi.fn();
    const unsubscribe = native.onDeepLink(listener);
    expect(addListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
    fire({ url: `collectors://cap/${ID}` });
    expect(listener).toHaveBeenCalledWith(`collectors://cap/${ID}`);
    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();

    const web = createWebPlatform(window);
    const webListener = vi.fn();
    web.onDeepLink(webListener)();
    expect(webListener).not.toHaveBeenCalled();
  });
});
