// Batch summary (CAP-84; SCREENS.md § Batch mode "Summary"): `/scan/batch/summary`, once every item is resolved or
// skipped. Counts: added · already in collection (updated / discarded) · manual · discarded · skipped, with "Review
// skipped" (only those run again). "Plan albums" (CAP-75, physical-link.md § Initial layout: "Plan layout…", which
// opens on the caps without a location) when the batch left caps without one. Done or Plan albums deletes the batch
// from the device.
import { abandonBatch, batchRunner } from '../batch/run.js';
import type { Batch } from '../batch/store.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export interface BatchCounts {
  readonly added: number;
  readonly updated: number;
  readonly alreadyDiscarded: number;
  readonly manual: number;
  readonly discarded: number;
  readonly skipped: number;
  readonly failed: number;
  /** Caps saved or updated by this batch that have no location. */
  readonly unplaced: number;
}

export function batchCounts(batch: Batch): BatchCounts {
  const items = batch.items;
  const duplicate = (i: Batch['items'][number]) => i.response?.outcome === 'duplicate';
  return {
    added: items.filter((i) => i.resolution === 'saved').length,
    updated: items.filter((i) => i.resolution === 'updated').length,
    alreadyDiscarded: items.filter((i) => i.resolution === 'discarded' && duplicate(i)).length,
    manual: items.filter((i) => i.resolution === 'manual').length,
    discarded: items.filter((i) => i.resolution === 'discarded' && !duplicate(i)).length,
    skipped: items.filter((i) => i.state === 'skipped').length,
    failed: items.filter((i) => i.state === 'failed').length,
    unplaced: items.filter((i) => i.unplaced).length,
  };
}

export const BatchSummaryScreen: Screen = (ctx: AppContext) => {
  const body = h('div', { class: 'batch-body' });
  const el = h(
    'section',
    { class: 'screen batch-summary' },
    h('header', { class: 'screen-header' }, h('h1', { class: 'screen-title' }, t('batch.summaryTitle'))),
    body,
  );
  void ctx.batch.store.current().then((batch) => {
    if (batch === null) {
      body.replaceChildren(
        h('p', { class: 'muted', attrs: { role: 'status' } }, t('batch.none')),
        h('a', { class: 'button', attrs: { href: pathFor('scan'), 'data-link': true } }, t('batch.toScan')),
      );
      return;
    }
    const counts = batchCounts(batch);
    const row = (key: MessageKey, n: number, name: string) =>
      h('div', { class: 'batch-count', attrs: { 'data-count': name } }, h('dt', {}, t(key)), h('dd', {}, String(n)));
    const finish = (path: string) => async () => {
      await abandonBatch(ctx);
      ctx.navigate(path);
    };
    const button = (key: MessageKey, action: string, onClick: () => Promise<void>, secondary = false) =>
      h(
        'button',
        {
          class: secondary ? 'button button--secondary' : 'button',
          attrs: { type: 'button', 'data-action': action },
          on: { click: () => void onClick() },
        },
        t(key),
      );
    body.replaceChildren(
      h(
        'dl',
        { class: 'batch-counts' },
        row('batch.added', counts.added, 'added'),
        row('batch.already', counts.updated + counts.alreadyDiscarded, 'already'),
        h(
          'p',
          { class: 'muted batch-already', attrs: { 'data-count': 'already-split' } },
          t('batch.alreadySplit', { updated: counts.updated, discarded: counts.alreadyDiscarded }),
        ),
        row('batch.manual', counts.manual, 'manual'),
        row('batch.discarded', counts.discarded, 'discarded'),
        row('batch.skipped', counts.skipped, 'skipped'),
        counts.failed > 0 && row('batch.failed', counts.failed, 'failed'),
      ),
      ...(counts.skipped > 0
        ? [
            button('batch.reviewSkipped', 'review-skipped', async () => {
              const runner = await batchRunner(ctx);
              await runner?.reviewSkipped();
              ctx.navigate(pathFor('scanBatch'));
            }),
          ]
        : []),
      ...(counts.unplaced > 0 ? [button('batch.planAlbums', 'plan-albums', finish(pathFor('albumLayout')))] : []),
      button('batch.done', 'batch-done', finish(pathFor('collection')), counts.unplaced > 0),
    );
  });
  return el;
};
