// Sign-in screen (CAP-22, ADR-008 §4, SCREENS.md § Visual system): one "Sign in with Apple" button styled per
// Apple's HIG (black, Apple logo, full width), with error states for a refused Apple ID (403), an unreachable
// network and a build without Apple configuration. On success the session store changes and the shell routes to
// Collection (app.ts); a cancelled sheet just re-enables the button.
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

export const SignInScreen: Screen = (ctx) => {
  const error = h('p', { class: 'status status--error', attrs: { role: 'alert' } });

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
          void signIn(ctx).then((result) => {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (result.kind === 'failed') error.textContent = t(FAILURE_MESSAGE[result.reason]);
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
      ctx.config.dev &&
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => ctx.skipSignIn() } },
          t('signIn.skip'),
        ),
    ),
  );
};
