// Settings skeleton (CAP-21): API URL override (development builds only), app version, AI on/off placeholder,
// and a connection check against GET /healthz.
import { ScreenHeader } from '../components/screen-header.js';
import { ConfigError } from '../config.js';
import type { Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { h } from '../ui/dom.js';

export const SettingsScreen: Screen = (ctx) => {
  const status = h('p', { class: 'status', attrs: { role: 'status' } });

  const apiSection = () => {
    const input = h('input', {
      class: 'input',
      attrs: { id: 'api-url', type: 'url', inputmode: 'url', autocomplete: 'off', value: ctx.apiUrl.override() ?? '' },
    });
    input.placeholder = ctx.config.apiUrl ?? '';
    const form = h(
      'form',
      {
        class: 'field',
        on: {
          submit: (event) => {
            event.preventDefault();
            ctx.apiUrl.setOverride(input.value).then(
              () => (status.textContent = t('settings.apiUrlSaved')),
              (error: unknown) => {
                if (!(error instanceof ConfigError)) throw error;
                status.textContent = t('settings.apiUrlInvalid');
              },
            );
          },
        },
      },
      h('label', { attrs: { for: 'api-url' } }, t('settings.apiUrl')),
      input,
      h('small', { class: 'muted' }, t('settings.apiUrlHint')),
      h('button', { class: 'button', attrs: { type: 'submit' } }, t('common.save')),
    );
    return form;
  };

  const check = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (ctx.apiUrl.current() === null) {
            status.textContent = t('settings.apiNotConfigured');
            return;
          }
          ctx.api.healthz().then(
            () => (status.textContent = t('settings.apiOk')),
            () => (status.textContent = t('settings.apiFailed')),
          );
        },
      },
    },
    t('settings.checkApi'),
  );

  return h(
    'section',
    { class: 'screen' },
    ScreenHeader(t('settings.title')),
    ctx.config.dev && apiSection(),
    check,
    status,
    h(
      'label',
      { class: 'field field--row' },
      h('input', { attrs: { type: 'checkbox', disabled: true, name: 'ai' } }),
      h('span', {}, t('settings.ai')),
    ),
    h('small', { class: 'muted' }, t('settings.aiHint')),
    h('dl', { class: 'meta' }, h('dt', {}, t('settings.version')), h('dd', {}, ctx.config.version)),
  );
};
