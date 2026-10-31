// Placeholder root view of the V0 skeleton (CAP-11). Replaced by the app-shell story (EP-04).
// Proves the shared contracts package resolves from app/ (it exports nothing yet; EP-01 fills it in).
import '@capcollector/shared';

export const APP_TITLE = 'CapCollector';

export function renderApp(root: HTMLElement): void {
  const heading = document.createElement('h1');
  heading.textContent = APP_TITLE;
  root.replaceChildren(heading);
}
