// "⋯" and sort menus (SCREENS.md § Navigation logic, CAP-90): every `details.more-menu` closes on a pointerdown
// outside it and on Escape (focus back to its `summary`), and opening one closes any other. Installed once by the app
// shell on the document, so the screens keep building plain `<details>`; picking an item still closes the menu as each
// screen already does. A pointerdown inside an open menu is left alone, so its links and buttons still work.
const MENU = 'details.more-menu';

function openMenus(doc: Document): HTMLDetailsElement[] {
  return [...doc.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`)];
}

/** Starts the document-wide menu behaviour; returns the function that removes it. */
export function installMenuDismissal(doc: Document): () => void {
  const onPointerDown = (event: Event) => {
    const target = event.target instanceof Node ? event.target : null;
    for (const menu of openMenus(doc)) {
      if (target === null || !menu.contains(target)) menu.open = false;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    const open = openMenus(doc);
    for (const menu of open) menu.open = false;
    const summary = open.at(-1)?.querySelector<HTMLElement>(':scope > summary');
    summary?.focus();
  };
  // Keyboard opening (Enter/Space on the summary) does not pass through pointerdown: `toggle` covers it.
  const onToggle = (event: Event) => {
    const opened = event.target;
    if (!(opened instanceof HTMLDetailsElement) || !opened.matches(MENU) || !opened.open) return;
    for (const menu of openMenus(doc)) if (menu !== opened) menu.open = false;
  };
  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('toggle', onToggle, true);
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('toggle', onToggle, true);
  };
}
