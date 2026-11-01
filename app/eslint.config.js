// ESLint flat config for app/ (ESLint ≥ 10 resolves the nearest config per file, so this replaces the root one
// for app files). It repeats the root rules — a workspace may not import files outside itself (T-infra-015) —
// and adds the app boundary: Capacitor plugins are only imported under src/platform/capacitor/ (CAP-21).
// The recommended set is read from `tseslint.plugin.configs`, not the `tseslint.configs` getters: the getters register
// this directory as a second tsconfig root and break parsing of the root workspace files in the same ESLint run.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts', 'ios/**', 'android/**'] },
  js.configs.recommended,
  ...tseslint.plugin.configs['flat/recommended'],
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: ['src/platform/capacitor/**', 'capacitor.config.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@capacitor/*'],
              message: 'Capacitor is only imported in src/platform/capacitor/ — use the Platform adapter.',
            },
          ],
        },
      ],
    },
  },
  prettier,
];
