// Test setup (CAP-97): the app defaults to Spanish, but the screen tests assert the English copy, so every test starts
// in English. Tests of the language itself switch with setLanguage and are reset here before the next test.
import { beforeEach } from 'vitest';

import { setLanguage } from '../src/i18n/i18n.js';

setLanguage('en');
beforeEach(() => setLanguage('en'));
