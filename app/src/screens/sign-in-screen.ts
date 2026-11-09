// Sign-in screen (CAP-22, ADR-008 §4, SCREENS.md § Visual system): one "Sign in with Apple" button styled per
// Apple's HIG (black, Apple logo, full width), with error states for a refused Apple ID (403), an unreachable
// network and a build without Apple configuration. On success the session store changes and the shell routes to
// Collection — or the cap link that was waiting for it (CAP-54) — (app.ts); a cancelled sheet re-enables the button and
// drops that pending link.
import { signIn, type SignInFailure } from '../auth/sign-in.js';
import type { Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { h } from '../ui/dom.js';

const FAILURE_MESSAGE: Readonly<Record<SignInFailure, MessageKey>> = {
  'not-allowed': 'signIn.notAllowed',
  network: 'signIn.network',
  unavailable: 'signIn.unavailable',
  failed: 'signIn.failed',
};

/**
 * CAP-28: on a refused Apple ID, its `sub` (decoded locally from the identity token) with a copy action, so it can be
 * added to the server allow-list. Copy uses the Clipboard API; where it is unavailable the id is selected instead.
 */
function AppleSubPanel(sub: string): HTMLElement {
  const code = h('code', { class: 'apple-sub__value' }, sub);
  const copy = h(
    'button',
    {
      class: 'button button--secondary apple-sub__copy',
      attrs: { type: 'button' },
      on: {
        click: () => {
          const select = () => window.getSelection()?.selectAllChildren(code);
          const clipboard = window.navigator.clipboard as Clipboard | undefined;
          if (!clipboard) return select();
          clipboard.writeText(sub).then(() => (copy.textContent = t('signIn.copied')), select);
        },
      },
    },
    t('signIn.copy'),
  );
  return h('div', { class: 'apple-sub' }, h('p', { class: 'muted' }, t('signIn.notAllowedSub')), code, copy);
}

export const SignInScreen: Screen = (ctx) => {
  const error = h('p', { class: 'status status--error', attrs: { role: 'alert' } });
  const subSlot = h('div', { class: 'apple-sub-slot' });

  const button = h(
    'button',
    {
      class: 'button button--apple',
      attrs: { type: 'button' },
      on: {
        click: () => {
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          error.textContent = '';
          subSlot.replaceChildren();
          void signIn(ctx).then((result) => {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (result.kind === 'cancelled') ctx.cancelPendingRoute?.();
            if (result.kind !== 'failed') return;
            error.textContent = t(FAILURE_MESSAGE[result.reason]);
            if (result.appleSub !== undefined) subSlot.replaceChildren(AppleSubPanel(result.appleSub));
          });
        },
      },
    },
    h('span', { class: 'apple-logo', attrs: { 'aria-hidden': 'true' } }),
    h('span', {}, t('signIn.button')),
  );

  return h(
    'section',
    { class: 'screen sign-in' },
    h(
      'div',
      { class: 'sign-in__brand' },
      h('span', { class: 'sign-in__mark', attrs: { 'aria-hidden': 'true' } }),
      h('h1', { class: 'screen-title' }, t('app.name')),
      h('p', { class: 'muted' }, t('signIn.tagline')),
    ),
    h(
      'div',
      { class: 'sign-in__actions' },
      button,
      error,
      subSlot,
      ctx.config.dev &&
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => ctx.skipSignIn() } },
          t('signIn.skip'),
        ),
    ),
  );
};
