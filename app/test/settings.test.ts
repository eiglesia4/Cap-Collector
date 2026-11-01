// Tests for the Settings skeleton: dev-only API URL override, connection check, version, AI placeholder (CAP-21).
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client';
import { NetworkError } from '../src/api/errors';
import { matchRoute } from '../src/router/routes';
import { SettingsScreen } from '../src/screens/settings-screen';
import { t } from '../src/i18n/i18n';
import { flush, shellContext, TEST_CONFIG } from './support/fakes';

function render(config = TEST_CONFIG, healthz: ApiClient['healthz'] = vi.fn(async () => ({ status: 'ok' as const }))) {
  const api: ApiClient = { request: vi.fn(), healthz };
  const ctx = { ...shellContext({ config, api }), navigate: vi.fn() };
  const route = matchRoute('/settings');
  if (!route) throw new Error('no route');
  const el = SettingsScreen(ctx, route);
  const status = () => el.querySelector('[role="status"]')?.textContent;
  return { el, ctx, status };
}

describe('settings screen', () => {
  it('[T-app-013] saves a valid API URL override in development, rejects invalid ones, checks /healthz and shows the version', async () => {
    const { el, ctx, status } = render();
    expect(el.querySelector('h1')?.textContent).toBe(t('settings.title'));
    expect(el.querySelector('dd')?.textContent).toBe('1.2.3');
    expect(el.querySelector<HTMLInputElement>('input[name="ai"]')?.disabled).toBe(true);

    const input = el.querySelector<HTMLInputElement>('#api-url');
    const form = el.querySelector('form');
    if (!input || !form) throw new Error('no API URL form');
    expect(input.placeholder).toBe('https://api.test');

    input.value = 'nope';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(status()).toBe(t('settings.apiUrlInvalid'));

    input.value = 'http://localhost:3000';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(status()).toBe(t('settings.apiUrlSaved'));
    expect(ctx.apiUrl.current()).toBe('http://localhost:3000');

    el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await flush();
    expect(ctx.api.healthz).toHaveBeenCalled();
    expect(status()).toBe(t('settings.apiOk'));

    const failing = render(
      TEST_CONFIG,
      vi.fn(async () => Promise.reject(new NetworkError('offline'))),
    );
    failing.el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await flush();
    expect(failing.status()).toBe(t('settings.apiFailed'));

    // Production build: no override field; without an API URL the check says so instead of calling.
    const prod = render({ apiUrl: null, version: '0.2.0', dev: false });
    expect(prod.el.querySelector('#api-url')).toBeNull();
    prod.el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    expect(prod.status()).toBe(t('settings.apiNotConfigured'));
    expect(prod.ctx.api.healthz).not.toHaveBeenCalled();
  });
});
