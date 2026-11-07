// Bottom confirmation sheet (CAP-24: delete a cap). Resolves true on confirm, false on cancel or a tap on the backdrop.
import { h } from '../ui/dom.js';

export interface ConfirmOptions {
  readonly message: string;
  readonly confirm: string;
  readonly cancel: string;
  /** Style the confirm button as destructive. */
  readonly danger?: boolean;
}

export function ConfirmSheet(host: HTMLElement, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (answer: boolean) => {
      backdrop.remove();
      resolve(answer);
    };
    const backdrop = h(
      'div',
      { class: 'sheet-backdrop', on: { click: (e) => e.target === backdrop && close(false) } },
      h(
        'div',
        { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true' } },
        h('p', { class: 'sheet-message' }, options.message),
        h(
          'button',
          {
            class: options.danger ? 'button button--danger' : 'button',
            attrs: { type: 'button', 'data-confirm': true },
            on: { click: () => close(true) },
          },
          options.confirm,
        ),
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => close(false) } },
          options.cancel,
        ),
      ),
    );
    host.append(backdrop);
  });
}
