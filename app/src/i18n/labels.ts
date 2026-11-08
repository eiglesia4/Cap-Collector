// i18n keys of the shared enums shown as labels (CAP-23 chips, CAP-24 detail chips, CAP-25 form selects).
import type { CapType, Closure, Condition, Material } from '@capcollector/shared';

import type { MessageKey } from './i18n.js';

export const TYPE_LABEL: Readonly<Record<CapType, MessageKey>> = {
  beer: 'capType.beer',
  'soft drink': 'capType.softDrink',
  water: 'capType.water',
  cider: 'capType.cider',
  wine: 'capType.wine',
  other: 'capType.other',
};

export const MATERIAL_LABEL: Readonly<Record<Material, MessageKey>> = {
  steel: 'material.steel',
  aluminium: 'material.aluminium',
  plastic: 'material.plastic',
};

export const CLOSURE_LABEL: Readonly<Record<Closure, MessageKey>> = {
  'pry-off': 'closure.pryOff',
  'twist-off': 'closure.twistOff',
};

export const CONDITION_LABEL: Readonly<Record<Condition, MessageKey>> = {
  mint: 'condition.mint',
  good: 'condition.good',
  worn: 'condition.worn',
  damaged: 'condition.damaged',
};
