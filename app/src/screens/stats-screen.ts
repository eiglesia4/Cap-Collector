// Stats tab (CAP-58; features.md § Phase 2 "Stats tab"; SCREENS.md inventory, "phase 2 / simple lists"): totals and
// CSS bar lists by country (top 15 + others), type, year (decades when spread out), status and caps added per month
// over the last 12 months, computed on the client from every live cap (stats/aggregate.ts). A country, type or
// "needs review" bar links to Collection with that filter (`/?country=ES`). Cached in memory; Refresh (and pull down
// on the iPhone) fetches again. Styles: styles/stats.css.
import type { CapType } from '@capcollector/shared';

import { collectionFilterPath, type CollectionFilter } from '../collection/query.js';
import { ScreenHeader } from '../components/screen-header.js';
import type { Screen } from '../context.js';
import { countryName } from '../i18n/countries.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { TYPE_LABEL } from '../i18n/labels.js';
import { collectionStats, OTHERS, UNKNOWN, type Bar, type Stats } from '../stats/aggregate.js';
import { statsCaps } from '../stats/data.js';
import { h } from '../ui/dom.js';

/** Pull distance (px) that refreshes on the iPhone, as on Collection. */
const PULL_THRESHOLD = 70;

const numberFormat = new Intl.NumberFormat('en-US');
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

const STATUS_LABEL: Readonly<Record<string, MessageKey>> = {
  complete: 'stats.status.complete',
  needsReview: 'stats.status.needsReview',
  unidentified: 'stats.status.unidentified',
};

interface Series {
  readonly title: string;
  readonly bars: readonly Bar[];
  readonly label: (key: string) => string;
  /** The Collection filter a bar opens, or undefined when Collection cannot filter by it. */
  readonly filter?: (key: string) => CollectionFilter | undefined;
}

function common(key: string): string | null {
  if (key === OTHERS) return t('stats.others');
  if (key === UNKNOWN) return t('stats.unknown');
  return null;
}

function BarList(series: Series): HTMLElement {
  const max = Math.max(1, ...series.bars.map((b) => b.count));
  const rows = series.bars.map((bar) => {
    const fill = h('span', { class: 'stats-bar__fill' });
    fill.style.width = `${String((bar.count / max) * 100)}%`;
    const children = [
      h('span', { class: 'stats-bar__label' }, series.label(bar.key)),
      h('span', { class: 'stats-bar__track', attrs: { 'aria-hidden': 'true' } }, fill),
      h('span', { class: 'stats-bar__count' }, numberFormat.format(bar.count)),
    ];
    const filter = bar.count > 0 ? series.filter?.(bar.key) : undefined;
    const row =
      filter === undefined
        ? h('div', { class: 'stats-bar' }, ...children)
        : h(
            'a',
            { class: 'stats-bar stats-bar--link', attrs: { href: collectionFilterPath(filter), 'data-link': true } },
            ...children,
          );
    row.dataset.key = bar.key;
    return h('li', {}, row);
  });
  return h(
    'section',
    { class: 'stats-section' },
    h('h2', { class: 'stats-section__title' }, series.title),
    h('ul', { class: 'stats-bars' }, ...rows),
  );
}

function Totals(stats: Stats): HTMLElement {
  const item = (label: MessageKey, n: number, key: string) =>
    h(
      'div',
      { class: 'stats-total', attrs: { 'data-total': key } },
      h('dt', {}, t(label)),
      h('dd', {}, numberFormat.format(n)),
    );
  const { totals } = stats;
  return h(
    'dl',
    { class: 'stats-totals' },
    item('stats.total.caps', totals.caps, 'caps'),
    item('stats.total.brands', totals.brands, 'brands'),
    item('stats.total.countries', totals.countries, 'countries'),
    item('stats.total.inAlbum', totals.inAlbum, 'inAlbum'),
    item('stats.total.loose', totals.loose, 'loose'),
    item('stats.total.unplaced', totals.unplaced, 'unplaced'),
  );
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return monthFormat.format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1)));
}

export function StatsView(stats: Stats): HTMLElement[] {
  if (stats.totals.caps === 0) return [h('p', { class: 'muted' }, t('stats.empty'))];
  const decade = stats.byYear.unit === 'decade';
  return [
    Totals(stats),
    BarList({
      title: t('stats.byCountry'),
      bars: stats.byCountry,
      label: (key) => common(key) ?? countryName(key),
      filter: (key) => (common(key) === null ? { country: key } : undefined),
    }),
    BarList({
      title: t('stats.byType'),
      bars: stats.byType,
      label: (key) => common(key) ?? t(TYPE_LABEL[key as CapType]),
      filter: (key) => (common(key) === null ? { type: key as CapType } : undefined),
    }),
    BarList({
      title: t(decade ? 'stats.byDecade' : 'stats.byYear'),
      bars: stats.byYear.bars,
      label: (key) => common(key) ?? (decade ? t('stats.decade', { decade: key }) : key),
    }),
    BarList({
      title: t('stats.byStatus'),
      bars: stats.byStatus,
      label: (key) => t(STATUS_LABEL[key] ?? 'stats.unknown'),
      filter: (key) => (key === 'needsReview' ? { needsReview: true } : undefined),
    }),
    BarList({ title: t('stats.perMonth'), bars: stats.perMonth, label: monthLabel }),
  ];
}

export const StatsScreen: Screen = (ctx) => {
  const body = h('div', { class: 'stats-body' });
  const refresh = h(
    'button',
    {
      class: 'header-action',
      attrs: { type: 'button', 'data-action': 'refresh' },
      on: { click: () => void load(true) },
    },
    t('stats.refresh'),
  );

  async function load(again = false): Promise<void> {
    refresh.disabled = true;
    if (again || body.childElementCount === 0)
      body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('stats.loading')));
    try {
      const caps = await statsCaps(ctx.api, again);
      body.replaceChildren(...StatsView(collectionStats(caps, new Date())));
    } catch {
      body.replaceChildren(
        h('p', { attrs: { role: 'alert' } }, t('stats.failed')),
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void load(true) } },
          t('common.retry'),
        ),
      );
    } finally {
      refresh.disabled = false;
    }
  }

  const el = h('section', { class: 'screen stats' }, ScreenHeader(t('stats.title'), refresh), body);

  if (ctx.platform.kind === 'native') {
    let startY: number | null = null;
    el.addEventListener(
      'touchstart',
      (e) => {
        startY = window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      },
      { passive: true },
    );
    el.addEventListener('touchend', (e) => {
      const endY = e.changedTouches[0]?.clientY;
      if (startY !== null && endY !== undefined && endY - startY >= PULL_THRESHOLD) void load(true);
      startY = null;
    });
  }

  void load();
  return el;
};
