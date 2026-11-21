// The batch strip over screens 3/4/5 and the batch hub (CAP-84; SCREENS.md § Batch mode "Batch run"): "4 of 11", a
// row of the batch's items (✓ resolved, current, waiting, skipped, failed), Skip (keep it for later) and Stop (leave
// the batch; it stays unfinished and the Scan / Collection banner offers Continue).
import type { Batch } from '../batch/store.js';
import type { AppContext } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

const MARK: Readonly<Record<Batch['items'][number]['state'], string>> = {
  waiting: '',
  analysing: '',
  ready: '',
  resolved: '✓',
  skipped: '–',
  failed: '!',
};

export function BatchStrip(ctx: AppContext, index: number): HTMLElement {
  const runner = ctx.batch.runner;
  const strip = h('div', { class: 'batch-strip', attrs: { 'data-batch-strip': '' } });
  if (runner === null) return strip;
  const count = h('p', { class: 'batch-strip__count', attrs: { 'data-batch-count': '' } });
  const row = h('ol', { class: 'batch-strip__row', attrs: { 'aria-label': t('batch.items') } });
  const render = (batch: Batch) => {
    count.textContent = t('batch.position', { at: index + 1, total: batch.items.length });
    row.replaceChildren(
      ...batch.items.map((item) => {
        const li = h('li', { class: `batch-dot batch-dot--${item.state}` }, MARK[item.state] || String(item.index + 1));
        li.dataset.state = item.state;
        if (item.index === index) li.setAttribute('aria-current', 'step');
        return li;
      }),
    );
  };
  render(runner.batch());
  // Kept up to date while prefetched items finish; stops listening once the strip is gone.
  const stop = runner.subscribe((batch) => {
    if (!strip.isConnected) return stop();
    render(batch);
  });
  const action = (key: 'batch.skip' | 'batch.stop', name: string, onClick: () => Promise<void> | void) =>
    h(
      'button',
      {
        class: 'button button--secondary button--small',
        attrs: { type: 'button', 'data-action': name },
        on: { click: () => void onClick() },
      },
      t(key),
    );
  strip.append(
    count,
    row,
    h(
      'div',
      { class: 'batch-strip__actions' },
      action('batch.skip', 'batch-skip', async () => {
        await runner.skip(index);
        ctx.capture.clear();
        ctx.navigate(pathFor('scanBatch'));
      }),
      action('batch.stop', 'batch-stop', () => {
        ctx.capture.clear();
        ctx.navigate(pathFor('scan'));
      }),
    ),
  );
  return strip;
}
