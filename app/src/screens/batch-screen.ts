// The batch (CAP-83, interim; ADR-009 §3, §5): `/scan/batch` lists the unfinished batch's crops with their numbers and
// "Discard batch". CAP-84 replaces it with the batch run (each cap through AI review / Already / Manual, "4 of 11").
import type { Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

export const BatchScreen: Screen = (ctx) => {
  const title = h('h1', { class: 'screen-title' }, t('batch.title'));
  const close = h(
    'a',
    { class: 'header-action', attrs: { href: pathFor('scan'), 'data-link': true } },
    t('common.close'),
  );
  const body = h('div', { class: 'batch-body' });
  const el = h('section', { class: 'screen batch' }, h('header', { class: 'screen-header' }, close, title), body);

  void ctx.batch.store.current().then((batch) => {
    if (batch === null) {
      body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('batch.none')));
      return;
    }
    title.textContent = t('batch.titleCount', { count: batch.items.length });
    const discard = h(
      'button',
      {
        class: 'button button--secondary',
        attrs: { type: 'button', 'data-action': 'discard-batch' },
        on: {
          click: () =>
            void ctx.batch.store.discard().then(() => {
              ctx.navigate(pathFor('scan'));
            }),
        },
      },
      t('batch.discard'),
    );
    body.replaceChildren(
      h('p', { class: 'muted' }, t('batch.interim')),
      h(
        'ol',
        { class: 'batch-crops' },
        ...batch.items.map((item) => {
          const url = objectUrl(item.photo);
          const li = h(
            'li',
            { class: 'batch-crop' },
            url === null ? '' : h('img', { class: 'batch-thumb', attrs: { src: url, alt: '' } }),
            h('span', { class: 'batch-number' }, String(item.index + 1)),
          );
          li.dataset.index = String(item.index);
          return li;
        }),
      ),
      discard,
    );
  });
  return el;
};
