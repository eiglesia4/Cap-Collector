// "Batch: 4 of 11 — Continue · Abandon" on Scan and Collection while a batch is unfinished (CAP-84; SCREENS.md § Batch
// mode "Resume"). Abandon asks first and deletes the local crops; the caps already saved stay saved.
import { abandonBatch } from '../batch/run.js';
import type { AppContext } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';
import { ConfirmSheet } from './confirm-sheet.js';

/** The banner (empty and hidden until the store answers, and when there is no batch). */
export function BatchBanner(ctx: AppContext, onAbandon: () => void = () => undefined): HTMLElement {
  const banner = h('div', { class: 'batch-banner', attrs: { role: 'status', 'data-batch-banner': '' } });
  banner.hidden = true;
  void ctx.batch.store.current().then((batch) => {
    if (batch === null) return;
    const open = batch.items.find((i) => i.state !== 'resolved' && i.state !== 'skipped');
    const at = open === undefined ? batch.items.length : open.index + 1;
    banner.replaceChildren(
      h('span', { class: 'batch-banner__text' }, t('batch.banner', { at, total: batch.items.length })),
      h(
        'button',
        {
          class: 'button button--small',
          attrs: { type: 'button', 'data-action': 'continue-batch' },
          on: { click: () => ctx.navigate(pathFor('scanBatch')) },
        },
        t('batch.continue'),
      ),
      h(
        'button',
        {
          class: 'button button--secondary button--small',
          attrs: { type: 'button', 'data-action': 'discard-batch' },
          on: {
            click: () =>
              void (async () => {
                const host = banner.closest<HTMLElement>('.screen') ?? document.body;
                const sure = await ConfirmSheet(host, {
                  message: t('batch.abandonConfirm'),
                  confirm: t('batch.abandon'),
                  cancel: t('batch.keep'),
                  danger: true,
                });
                if (!sure) return;
                await abandonBatch(ctx);
                banner.hidden = true;
                banner.replaceChildren();
                onAbandon();
              })(),
          },
        },
        t('batch.abandon'),
      ),
    );
    banner.hidden = false;
  });
  return banner;
}
