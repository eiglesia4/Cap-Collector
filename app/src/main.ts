// Browser / Capacitor entry point (CAP-21): validates config, picks the platform, restores the session and
// mounts the shell into #app (index.html). An expired access token is refreshed silently after mounting (CAP-22).
import './styles/tokens.css';
import './styles/app.css';

import { createApiClient } from './api/client.js';
import { createApiUrlSetting } from './api-url.js';
import { renderApp } from './app.js';
import { restoreSession } from './auth/sign-in.js';
import { createCaptureStore } from './capture/context.js';
import { loadConfig } from './config.js';
import { selectPlatform } from './platform/select-platform.js';
import { createSessionStore } from './session/session-store.js';

async function start(root: HTMLElement): Promise<void> {
  const config = loadConfig(import.meta.env, __APP_VERSION__);
  const platform = await selectPlatform(window, config.apple);
  const session = createSessionStore(platform.store);
  const apiUrl = createApiUrlSetting(config, platform.store);
  await Promise.all([session.load(), apiUrl.load()]);
  const api = createApiClient({ baseUrl: apiUrl.current, session });
  renderApp(root, { config, platform, session, api, apiUrl, capture: createCaptureStore() });
  await restoreSession({ session, api });
}

const root = document.querySelector<HTMLElement>('#app');
if (root) void start(root);
