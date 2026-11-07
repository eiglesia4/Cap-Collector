// i18n keys of the shared enums shown as labels (CAP-23 chips, CAP-24 detail chips).
import type { CapType } from '@capcollector/shared';

import type { MessageKey } from './i18n.js';

export const TYPE_LABEL: Readonly<Record<CapType, MessageKey>> = {
  beer: 'capType.beer',
  'soft drink': 'capType.softDrink',
  water: 'capType.water',
  cider: 'capType.cider',
  wine: 'capType.wine',
  other: 'capType.other',
};
