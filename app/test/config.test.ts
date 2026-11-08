// Tests for config validation and the development API URL override (CAP-21).
import { describe, expect, it } from 'vitest';

import { createApiUrlSetting } from '../src/api-url';
import { ConfigError, DEV_API_URL_KEY, loadConfig, parseApiUrl, parseWebUrl } from '../src/config';
import { memoryStore } from './support/fakes';

describe('config', () => {
  it('[T-app-012] validates VITE_API_URL at load and applies the stored override only in development builds', async () => {
    expect(parseApiUrl(undefined)).toBeNull();
    expect(parseApiUrl('  ')).toBeNull();
    expect(parseApiUrl('https://abc.execute-api.eu-west-1.amazonaws.com/')).toBe(
      'https://abc.execute-api.eu-west-1.amazonaws.com',
    );
    expect(parseApiUrl('http://localhost:3000/dev//')).toBe('http://localhost:3000/dev');
    expect(() => parseApiUrl('not a url')).toThrow(ConfigError);
    expect(() => parseApiUrl('ftp://host')).toThrow(/http or https/);

    expect(loadConfig({ VITE_API_URL: 'https://api.test/', DEV: false }, '0.2.0')).toEqual({
      apiUrl: 'https://api.test',
      version: '0.2.0',
      dev: false,
      apple: null,
      webUrl: null,
    });
    expect(() => loadConfig({ VITE_API_URL: 'nope', DEV: true }, '0')).toThrow(ConfigError);

    const store = memoryStore({ [DEV_API_URL_KEY]: 'http://localhost:4000' });
    const dev = createApiUrlSetting(
      { apiUrl: 'https://api.test', version: '0', dev: true, apple: null, webUrl: null },
      store,
    );
    expect(dev.current()).toBe('https://api.test');
    await dev.load();
    expect(dev.current()).toBe('http://localhost:4000');
    await dev.setOverride('http://127.0.0.1:5000/');
    expect(store.data.get(DEV_API_URL_KEY)).toBe('http://127.0.0.1:5000');
    await expect(dev.setOverride('garbage')).rejects.toThrow(ConfigError);
    expect(dev.override()).toBe('http://127.0.0.1:5000');
    await dev.setOverride('');
    expect(dev.current()).toBe('https://api.test');
    expect(store.data.has(DEV_API_URL_KEY)).toBe(false);

    const corrupt = memoryStore({ [DEV_API_URL_KEY]: 'garbage' });
    const devCorrupt = createApiUrlSetting(
      { apiUrl: null, version: '0', dev: true, apple: null, webUrl: null },
      corrupt,
    );
    await devCorrupt.load();
    expect(devCorrupt.current()).toBeNull();
    expect(corrupt.data.has(DEV_API_URL_KEY)).toBe(false);

    const prod = createApiUrlSetting(
      { apiUrl: 'https://api.test', version: '0', dev: false, apple: null, webUrl: null },
      memoryStore({ [DEV_API_URL_KEY]: 'http://localhost:4000' }),
    );
    await prod.load();
    expect(prod.current()).toBe('https://api.test');
  });

  it('[T-app-061] VITE_WEB_URL is optional and, when set, must be a bare https origin (trailing slash allowed)', () => {
    expect(parseWebUrl(undefined)).toBeNull();
    expect(parseWebUrl(' ')).toBeNull();
    expect(parseWebUrl('https://caps.naevatec.com')).toBe('https://caps.naevatec.com');
    expect(parseWebUrl(' https://caps.naevatec.com/ ')).toBe('https://caps.naevatec.com');
    expect(parseWebUrl('https://localhost:5173')).toBe('https://localhost:5173');
    expect(() => parseWebUrl('caps.naevatec.com')).toThrow(/not a valid URL/);
    expect(() => parseWebUrl('http://caps.naevatec.com')).toThrow(/must be https/);
    for (const bad of ['https://caps.naevatec.com/app', 'https://caps.naevatec.com/?x=1', 'https://u:p@caps.test']) {
      expect(() => parseWebUrl(bad)).toThrow(/origin without path/);
    }
    expect(loadConfig({ VITE_WEB_URL: 'https://caps.naevatec.com/', DEV: false }, '1').webUrl).toBe(
      'https://caps.naevatec.com',
    );
    expect(() => loadConfig({ VITE_WEB_URL: 'http://caps.test', DEV: false }, '1')).toThrow(ConfigError);
  });
});
