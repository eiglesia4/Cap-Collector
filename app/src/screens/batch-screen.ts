// The batch hub (CAP-84; SCREENS.md § Batch mode "Batch run"; ADR-009 §3–5): `/scan/batch`. It opens the batch's
// runner (rebuilt from the on-device store after a restart), keeps the analyses going (current + 2, intra-batch guard)
// and sends the current item to its review screen — Already in collection, AI review or Manual entry, each with the
// batch strip — as soon as it is ready. While the current item is being analysed it shows the strip and a progress
// line; a failed item offers Retry (Skip is on the strip). When every item is resolved or skipped: the summary.
import { BatchStrip } from '../components/batch-strip.js';
import { batchRunner, type RunnerOptions } from '../batch/run.js';
import type { AppContext, Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

export function BatchView(ctx: AppContext, options: RunnerOptions = {}): HTMLElement {
  const title = h('h1', { class: 'screen-title' }, t('batch.title'));
  const close = h(
    'a',
    {
      class: 'header-action',
      attrs: { href: pathFor('scan'), 'data-link': true, 'data-action': 'batch-close' },
    },
    t('common.close'),
  );
  const body = h('div', { class: 'batch-body' });
  const el = h('section', { class: 'screen batch' }, h('header', { class: 'screen-header' }, close, title), body);
  body.append(h('p', { class: 'muted', attrs: { role: 'status' } }, t('batch.loadingRun')));

  void batchRunner(ctx, options).then((runner) => {
    if (runner === null) {
      body.replaceChildren(
        h('p', { class: 'muted', attrs: { role: 'status' } }, t('batch.none')),
        h('a', { class: 'button', attrs: { href: pathFor('scan'), 'data-link': true } }, t('batch.toScan')),
      );
      return;
    }
    let left = false;
    let shown: string | null = null;
    const leave = (path: string) => {
      left = true;
      unsubscribe();
      ctx.navigate(path);
    };
    const render = () => {
      if (left) return;
      const at = runner.current();
      if (at === null) return leave(pathFor('scanBatchSummary'));
      const item = runner.batch().items[at];
      if (!item) return;
      title.textContent = t('batch.position', { at: at + 1, total: runner.batch().items.length });
      if (item.state === 'ready') {
        const session = runner.session(at);
        const route = runner.routeOf(at);
        if (session && route) {
          ctx.capture.start(session);
          return leave(route);
        }
      }
      // Re-render only when what is shown changes (the strip keeps itself up to date).
      const key = `${String(at)}:${item.state}`;
      if (key === shown) return;
      shown = key;
      const url = objectUrl(item.photo);
      const photo = url === null ? '' : h('img', { class: 'batch-current', attrs: { src: url, alt: '' } });
      const failed = item.state === 'failed';
      body.replaceChildren(
        BatchStrip(ctx, at),
        photo,
        failed
          ? h(
              'p',
              { class: 'status status--error', attrs: { role: 'alert', 'data-failed': String(at) } },
              t('batch.itemFailed', { n: at + 1 }),
            )
          : h(
              'p',
              { class: 'scan-progress', attrs: { role: 'status', 'data-analysing': String(at) } },
              t('batch.analysing', { n: at + 1 }),
            ),
        ...(failed
          ? [
              h(
                'button',
                {
                  class: 'button',
                  attrs: { type: 'button', 'data-action': 'batch-retry' },
                  on: { click: () => void runner.retry(at) },
                },
                t('common.retry'),
              ),
            ]
          : []),
      );
    };
    const unsubscribe = runner.subscribe(render);
    runner.pump();
    render();
  });
  return el;
}

export const BatchScreen: Screen = (ctx) => BatchView(ctx);
