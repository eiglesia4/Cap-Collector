// Tests for the placeholder root view (CAP-11).
import { describe, expect, it } from 'vitest';

import { APP_TITLE, renderApp } from '../src/app';

describe('app placeholder', () => {
  it('[T-app-001] renders the app title into the root element, replacing previous content', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>stale</p>';
    renderApp(root);
    expect(root.querySelector('h1')?.textContent).toBe(APP_TITLE);
    expect(root.querySelector('p')).toBeNull();
  });
});
