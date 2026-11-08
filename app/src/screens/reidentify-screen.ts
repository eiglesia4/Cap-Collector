// Re-identify with AI (CAP-43; Detail ⋯ → "Re-identify with AI"; ADR-003 tick rule; openapi `POST /scans/analyse` with
// `capId` + `known`): the stored cap's own images (no upload) and dHash go to the analyser with what the record already
// has; the answer opens the one form in `edit` mode with "AI suggests: X" next to each differing field, applied only
// when the user accepts it → `PATCH`. A cap saved without a hash (manual photos, CAP-25) gets one computed here from its
// stored top photo, the same circular crop + dHash as a scan (CAP-36).
import { AnalyseResponse, Cap, Source } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { reidentifyBody, suggestionsFor } from '../capture/review.js';
import { newUlid } from '../capture/ulid.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { resizeToWebp, type CapPhoto } from '../images/resize.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';
import { CapForm } from './cap-form-screen.js';

export interface ReidentifyOptions {
  /** Circular crop + dHash of the stored photo when the cap has no hash; tests inject a fake. */
  readonly prepare?: (file: Blob) => Promise<CapPhoto>;
  /** GET of the stored photo's presigned URL. */
  readonly fetchImage?: (url: string) => Promise<Blob>;
  readonly newId?: () => string;
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status);
  return res.blob();
}

/** The cap's stored hash, or one computed from its stored top photo. */
async function hashOf(cap: Cap, options: ReidentifyOptions): Promise<string> {
  if (cap.dhash !== undefined) return cap.dhash;
  const url = cap.imageUrls?.top;
  if (url === undefined) throw new Error('no image URL to hash');
  const blob = await (options.fetchImage ?? fetchBlob)(url);
  const photo = await (options.prepare ?? ((file: Blob) => resizeToWebp(file, { crop: 'circle' })))(blob);
  return photo.dhash;
}

export function ReidentifyView(ctx: AppContext, capId: string, options: ReidentifyOptions = {}): HTMLElement {
  const back = pathFor('capDetail', { id: capId });
  const el = h('section', { class: 'screen reidentify' });
  const frame = (...body: Node[]) =>
    el.replaceChildren(
      h(
        'header',
        { class: 'screen-header' },
        h('a', { class: 'header-action', attrs: { href: back, 'data-link': true } }, t('common.cancel')),
        h('h1', { class: 'screen-title' }, t('reidentify.title')),
      ),
      ...body,
    );
  const status = (key: MessageKey, role = 'status') => h('p', { class: 'muted', attrs: { role } }, t(key));

  const run = async () => {
    frame(status('reidentify.asking'));
    try {
      const cap = await ctx.api.request(`/caps/${encodeURIComponent(capId)}`, { schema: Cap });
      const dhash = await hashOf(cap, options);
      const body = reidentifyBody(cap, (options.newId ?? (() => newUlid()))(), dhash);
      const response = await ctx.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse });
      const suggestions = suggestionsFor(cap, response.fields);
      if (suggestions.length === 0) {
        return frame(
          status('reidentify.nothing'),
          h('a', { class: 'button', attrs: { href: back, 'data-link': true } }, t('reidentify.back')),
        );
      }
      const source = Source.safeParse(`bedrock:${response.aiModel ?? ''}`);
      el.replaceChildren(
        CapForm(ctx, { mode: 'edit', cap, ai: { suggestions, source: source.success ? source.data : 'manual' } }),
      );
    } catch (error) {
      const code = error instanceof ProblemError || error instanceof HttpError ? error.status : undefined;
      frame(
        status(
          code === 503 ? 'scan.aiUnavailable' : code === 404 ? 'capDetail.notFound' : 'reidentify.failed',
          'alert',
        ),
        code === 404
          ? h('a', { class: 'button', attrs: { href: pathFor('collection'), 'data-link': true } }, t('reidentify.back'))
          : h(
              'button',
              {
                class: 'button button--secondary',
                attrs: { type: 'button', 'data-action': 'retry' },
                on: { click: () => void run() },
              },
              t('common.retry'),
            ),
      );
    }
  };
  void run();
  return el;
}

/** `/cap/:id/reidentify`. */
export const ReidentifyScreen: Screen = (ctx, route) => ReidentifyView(ctx, route.params.id ?? '');
