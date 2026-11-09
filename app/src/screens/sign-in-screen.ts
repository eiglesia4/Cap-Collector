// Sign-in screen (CAP-22, ADR-008 §4, SCREENS.md § Visual system): one "Sign in with Apple" button styled per
// Apple's HIG (black, Apple logo, full width), with error states for a refused Apple ID (403), an unreachable
// network and a build without Apple configuration. On success the session store changes and the shell routes to
// Collection — or the cap link that was waiting for it (CAP-54) — (app.ts); a cancelled sheet re-enables the button and
// drops that pending link. CAP-64: the attempt is prepared on mount (Apple's SDK loaded and `init`ed, PKCE ready) and
// again after every attempt; the button stays disabled ("Loading…") until then, so the tap opens Apple's popup
// synchronously. A failed preparation (SDK blocked, offline, not configured) shows why, with Retry. Apple's
// `popup_blocked_by_browser` has its own message; other Apple codes are shown in small print.
import { prepareSignIn, signIn, type PreparedSignIn, type SignInFailure } from '../auth/sign-in.js';
import type { Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { h } from '../ui/dom.js';

const FAILURE_MESSAGE: Readonly<Record<SignInFailure, MessageKey>> = {
  'not-allowed': 'signIn.notAllowed',
  network: 'signIn.network',
  unavailable: 'signIn.unavailable',
  'popup-blocked': 'signIn.popupBlocked',
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
  const code = h('small', { class: 'muted sign-in__code', attrs: { 'data-apple-error': '' } });
  code.hidden = true;
  const subSlot = h('div', { class: 'apple-sub-slot' });
  const label = h('span', {}, t('signIn.loading'));
  let prepared: PreparedSignIn | null = null;

  const showFailure = (reason: SignInFailure, appleError?: string) => {
    error.textContent = t(FAILURE_MESSAGE[reason], { host: window.location.host });
    code.textContent = appleError === undefined ? '' : t('signIn.appleError', { code: appleError });
    code.hidden = appleError === undefined;
  };
  const clearFailure = () => {
    error.textContent = '';
    code.hidden = true;
    subSlot.replaceChildren();
    retrySlot.replaceChildren();
  };

  const retry = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button', 'data-action': 'retry' },
      on: {
        click: () => {
          clearFailure();
          prepare();
        },
      },
    },
    t('common.retry'),
  );
  // In the DOM only after a failed preparation.
  const retrySlot = h('div', { class: 'sign-in__retry' });

  function prepare(): void {
    prepared = null;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    label.textContent = t('signIn.loading');
    void prepareSignIn(ctx).then((result) => {
      button.removeAttribute('aria-busy');
      label.textContent = t('signIn.button');
      if (result.kind === 'failed') {
        showFailure(result.reason);
        retrySlot.replaceChildren(retry);
        return;
      }
      prepared = result.prepared;
      button.disabled = false;
    });
  }

  const button = h(
    'button',
    {
      class: 'button button--apple',
      attrs: { type: 'button' },
      on: {
        // Synchronous up to Apple's popup (CAP-64): no await before signIn.
        click: () => {
          const attempt = prepared;
          if (attempt === null) return;
          prepared = null;
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          clearFailure();
          void signIn(ctx, attempt).then((result) => {
            if (result.kind === 'cancelled') ctx.cancelPendingRoute?.();
            if (result.kind === 'failed') {
              showFailure(result.reason, result.appleError);
              if (result.appleSub !== undefined) subSlot.replaceChildren(AppleSubPanel(result.appleSub));
            }
            // A fresh state and nonce for the next attempt.
            prepare();
          });
        },
      },
    },
    h('span', { class: 'apple-logo', attrs: { 'aria-hidden': 'true' } }),
    label,
  );
  prepare();

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
      code,
      retrySlot,
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
