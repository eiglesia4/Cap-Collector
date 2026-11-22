// "⋯" and sort menus (CAP-90, SCREENS.md § Navigation logic): an outside pointerdown or Escape closes an open
// `details.more-menu`, opening one closes the others, and a tap inside leaves it open so its links still work.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installMenuDismissal } from '../src/ui/menus';

function menu(name: string): { details: HTMLDetailsElement; summary: HTMLElement; item: HTMLAnchorElement } {
  const details = document.createElement('details');
  details.className = 'more-menu';
  details.dataset.name = name;
  const summary = document.createElement('summary');
  summary.tabIndex = 0;
  const list = document.createElement('div');
  list.className = 'menu';
  const item = document.createElement('a');
  item.href = '/settings';
  list.append(item);
  details.append(summary, list);
  return { details, summary, item };
}

const pointerdown = (target: EventTarget) =>
  target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

let stop: () => void = () => undefined;
afterEach(() => {
  stop();
  document.body.replaceChildren();
});

describe('menu dismissal', () => {
  it('[T-app-162] an outside pointerdown closes an open menu; a pointerdown inside leaves it open and its link still fires', () => {
    stop = installMenuDismissal(document);
    const more = menu('more');
    const outside = document.createElement('p');
    document.body.append(more.details, outside);
    more.details.open = true;

    pointerdown(more.item);
    expect(more.details.open).toBe(true);
    const followed = vi.fn((e: Event) => e.preventDefault());
    more.item.addEventListener('click', followed);
    more.item.click();
    expect(followed).toHaveBeenCalledTimes(1);

    pointerdown(outside);
    expect(more.details.open).toBe(false);
    // A closed menu stays closed; uninstalled, nothing is touched.
    pointerdown(outside);
    expect(more.details.open).toBe(false);
    stop();
    more.details.open = true;
    pointerdown(outside);
    expect(more.details.open).toBe(true);
  });

  it('[T-app-163] Escape closes the open menu and focuses its summary; other keys do nothing', () => {
    stop = installMenuDismissal(document);
    const more = menu('more');
    document.body.append(more.details);
    more.details.open = true;
    more.item.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(more.details.open).toBe(true);
    more.item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(more.details.open).toBe(false);
    expect(document.activeElement).toBe(more.summary);
    // Escape with nothing open is harmless.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(more.details.open).toBe(false);
  });

  it('[T-app-164] opening a second menu closes the first (by tap or by keyboard toggle); other <details> are left alone', () => {
    stop = installMenuDismissal(document);
    const more = menu('more');
    const sort = menu('sort');
    const section = document.createElement('details');
    section.className = 'settings-scans';
    section.open = true;
    document.body.append(more.details, sort.details, section);

    more.details.open = true;
    pointerdown(sort.summary);
    sort.details.open = true;
    expect(more.details.open).toBe(false);

    // Keyboard opening: no pointerdown, only the `toggle` event of the opened menu.
    more.details.open = true;
    more.details.dispatchEvent(new Event('toggle'));
    expect(sort.details.open).toBe(false);
    expect(more.details.open).toBe(true);
    // A closing toggle, or a toggle of a non-menu <details>, closes nothing.
    sort.details.dispatchEvent(new Event('toggle'));
    section.dispatchEvent(new Event('toggle'));
    expect(more.details.open).toBe(true);
    expect(section.open).toBe(true);
  });
});
