// Sign-in screen (CAP-22, ADR-008 §4, SCREENS.md § Visual system): one "Sign in with Apple" button styled per
// Apple's HIG (black, Apple logo, full width), under the brand mark (CAP-74), with error states for a refused Apple ID (403), an unreachable
// network and a build without Apple configuration. On success the session store changes and the shell routes to
// Collection — or the cap link that was waiting for it (CAP-54) — (app.ts); a cancelled sheet re-enables the button and
// drops that pending link. CAP-64: the attempt is prepared on mount (Apple's SDK loaded and `init`ed, PKCE ready) and
// again after every attempt; the button stays disabled ("Loading…") until then, so the tap opens Apple's popup
// synchronously. A failed preparation (SDK blocked, offline, not configured) shows why, with Retry. Apple's
// `popup_blocked_by_browser` has its own message; other Apple codes are shown in small print.
// CAP-111 (ADR-011 §3, SCREENS.md § Sign-in): on the web with a Google client id, Google's own button sits under
// Apple's, same width. Google's script is loaded and the button rendered on the first render (fresh nonce per
// attempt); a refusal shows the Google `sub` to add to `google-identities`, a 401 asks to retry, and a script that does
// not load only hides Google — Apple stays usable. The platform adapter decides whether Google is offered at all.
// CAP-112: Android offers no Apple sign-in (ADR-011 §3): with no provider the screen says so. CAP-113: on Android the
// Google button is the app's own and opens the native Credential Manager sheet; the rest of the flow is shared.
import { finishGoogleSignIn, type GoogleSignInFailure } from '../auth/google-sign-in.js';
import { createPkce, type Pkce } from '../auth/pkce.js';
import type { GoogleNativeSignIn } from '../platform/platform.js';
import { prepareSignIn, signIn, type PreparedSignIn, type SignInFailure } from '../auth/sign-in.js';
import { BrandMark } from '../components/brand-mark.js';
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

const GOOGLE_FAILURE_MESSAGE: Readonly<Record<GoogleSignInFailure, MessageKey>> = {
  'not-allowed': 'signIn.googleNotAllowed',
  retry: 'signIn.googleRetry',
  network: 'signIn.network',
  failed: 'signIn.failed',
};

/**
 * CAP-28: on a refused Apple ID, its `sub` (decoded locally from the identity token) with a copy action, so it can be
 * added to the server allow-list. Copy uses the Clipboard API; where it is unavailable the id is selected instead.
 * CAP-111: the same panel for a refused Google account, with its own label (`google-identities`).
 */
const SUB_LABEL: Readonly<Record<Provider, MessageKey>> = {
  apple: 'signIn.notAllowedSub',
  google: 'signIn.googleNotAllowedSub',
};
type Provider = 'apple' | 'google';
const APPLE: Provider = 'apple';
const GOOGLE: Provider = 'google';

function SubPanel(sub: string, provider: Provider): HTMLElement {
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
  return h(
    'div',
    { class: 'apple-sub', attrs: { 'data-sub-provider': provider } },
    h('p', { class: 'muted' }, t(SUB_LABEL[provider])),
    code,
    copy,
  );
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
              if (result.appleSub !== undefined) {
                subSlot.replaceChildren(SubPanel(result.appleSub, APPLE));
              }
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
  const appleOffered = ctx.platform.features.appleSignIn;
  if (appleOffered) prepare();

  // ── Sign in with Google (CAP-111) ──
  const google = ctx.platform.google;
  const googleSlot = h('div', { class: 'google-button', attrs: { 'data-google': '' } });
  const googleStatus = h('p', { class: 'muted', attrs: { 'data-google-status': '' } });
  googleStatus.hidden = true;
  let googleBusy = false;

  /** Android (CAP-113): the app's button opens the native sheet for the attempt's nonce; a cancel is silent. */
  function nativeGoogleButton(native: GoogleNativeSignIn, pkce: Pkce): HTMLElement {
    const nativeButton = h(
      'button',
      {
        class: 'button button--google',
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (googleBusy) return;
            nativeButton.disabled = true;
            clearFailure();
            void native.signIn({ nonce: pkce.nonce }).then((result) => {
              nativeButton.disabled = false;
              if ('idToken' in result) return onGoogle(pkce, result.idToken);
              if ('error' in result) {
                error.textContent = t('signIn.failed');
                code.textContent = t('signIn.googleError', { code: result.error });
                code.hidden = false;
              }
            });
          },
        },
      },
      h('span', { class: 'google-logo', attrs: { 'aria-hidden': 'true' } }),
      h('span', {}, t('signIn.googleButton')),
    );
    return nativeButton;
  }

  /** Fresh verifier and nonce, then Google's button for them; a script that fails to load hides Google only. */
  function prepareGoogle(): void {
    if (!google) return;
    if (google.kind === 'native') {
      void createPkce().then((pkce) => googleSlot.replaceChildren(nativeGoogleButton(google, pkce)));
      return;
    }
    void createPkce()
      .then((pkce) => google.renderButton(googleSlot, { nonce: pkce.nonce }, (idToken) => onGoogle(pkce, idToken)))
      .then(
        () => {
          googleStatus.hidden = true;
        },
        () => {
          googleSlot.replaceChildren();
          googleStatus.textContent = t('signIn.googleUnavailable');
          googleStatus.hidden = false;
        },
      );
  }

  function onGoogle(pkce: Pkce, idToken: string): void {
    if (googleBusy) return;
    googleBusy = true;
    googleSlot.setAttribute('aria-busy', 'true');
    clearFailure();
    void finishGoogleSignIn(ctx, pkce, idToken).then((result) => {
      googleBusy = false;
      googleSlot.removeAttribute('aria-busy');
      if (result.kind === 'failed') {
        error.textContent = t(GOOGLE_FAILURE_MESSAGE[result.reason]);
        if (result.googleSub !== undefined) {
          subSlot.replaceChildren(SubPanel(result.googleSub, GOOGLE));
        }
        // A fresh nonce for the next attempt (one ID token per verifier).
        prepareGoogle();
      }
    });
  }
  prepareGoogle();

  return h(
    'section',
    { class: 'screen sign-in' },
    h(
      'div',
      { class: 'sign-in__brand' },
      BrandMark({ class: 'sign-in__mark' }),
      h('h1', { class: 'screen-title' }, t('app.name')),
      h('p', { class: 'muted' }, t('signIn.tagline')),
    ),
    h(
      'div',
      { class: 'sign-in__actions' },
      appleOffered && button,
      google && googleSlot,
      google && googleStatus,
      !appleOffered && !google && h('p', { class: 'muted', attrs: { 'data-no-provider': '' } }, t('signIn.noProvider')),
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
