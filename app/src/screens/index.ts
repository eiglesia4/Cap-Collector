// Route → screen table of the shell (CAP-21). Screens without their story yet render a placeholder.
import type { Screen } from '../context.js';
import type { RouteName } from '../router/routes.js';
import { CollectionScreen } from './collection-screen.js';
import { placeholderScreen } from './placeholder-screen.js';
import { ScanScreen } from './scan-screen.js';
import { SettingsScreen } from './settings-screen.js';

export const SCREENS: Readonly<Record<RouteName, Screen>> = {
  collection: CollectionScreen,
  scan: ScanScreen,
  wishlist: placeholderScreen('wishlist.title', 'wishlist.placeholder'),
  stats: placeholderScreen('stats.title', 'stats.placeholder'),
  capDetail: placeholderScreen('capDetail.title', 'capDetail.placeholder', 'collection'),
  capEdit: placeholderScreen('capEdit.title', 'form.placeholder', 'collection'),
  newCap: placeholderScreen('newCap.title', 'form.placeholder', 'scan'),
  albums: placeholderScreen('albums.title', 'albums.placeholder', 'collection'),
  exchange: placeholderScreen('exchange.title', 'exchange.placeholder', 'collection'),
  settings: SettingsScreen,
};
