// Route → screen table of the shell (CAP-21). Screens without their story yet render a placeholder.
import type { Screen } from '../context.js';
import type { RouteName } from '../router/routes.js';
import { CapDetailScreen } from './cap-detail-screen.js';
import { EditCapScreen, NewCapScreen, ScanReviewScreen } from './cap-form-screen.js';
import { CollectionScreen } from './collection-screen.js';
import { ExchangeScreen } from './exchange-screen.js';
import { placeholderScreen } from './placeholder-screen.js';
import { ScanDuplicateScreen } from './scan-duplicate-screen.js';
import { ReidentifyScreen } from './reidentify-screen.js';
import { ScanScreen } from './scan-screen.js';
import { SettingsScreen } from './settings-screen.js';
import { SignInScreen } from './sign-in-screen.js';

export const SCREENS: Readonly<Record<RouteName, Screen>> = {
  collection: CollectionScreen,
  scan: ScanScreen,
  wishlist: placeholderScreen('wishlist.title', 'wishlist.placeholder'),
  stats: placeholderScreen('stats.title', 'stats.placeholder'),
  capDetail: CapDetailScreen,
  capEdit: EditCapScreen,
  capReidentify: ReidentifyScreen,
  newCap: NewCapScreen,
  scanDuplicate: ScanDuplicateScreen,
  scanReview: ScanReviewScreen,
  albums: placeholderScreen('albums.title', 'albums.placeholder', 'collection'),
  exchange: ExchangeScreen,
  settings: SettingsScreen,
  signIn: SignInScreen,
};
