// Short-lived message at the bottom of the screen (CAP-24: "Deleted" after a delete). Lives on <body> so it outlives
// the screen that raised it; one toast at a time.
import { h } from '../ui/dom.js';

export const TOAST_MS = 5000;

export function showToast(text: string, doc: Document = document, ms = TOAST_MS): HTMLElement {
  doc.querySelector('.toast')?.remove();
  const toast = h('div', { class: 'toast', attrs: { role: 'status' } }, text);
  doc.body.append(toast);
  setTimeout(() => toast.remove(), ms);
  return toast;
}
