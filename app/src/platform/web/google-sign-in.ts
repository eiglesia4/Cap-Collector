// Web flow of Sign in with Google (ADR-011 §1, §3; CAP-111): Google Identity Services (`google.accounts.id`) loaded
// lazily from Google, like Apple's SDK, so there is no npm dependency. Each attempt `initialize`s GIS with the PKCE
// nonce (base64url(SHA-256(verifier))) and renders Google's own button; the popup / FedCM prompt returns the ID token
// to the callback directly, without a redirect. The script is loaded when the sign-in screen first renders, not on
// the tap, so the click opens Google's popup inside the user gesture (the CAP-64 lesson for Safari).
import type { GoogleConfig } from '../../config.js';
import { GoogleSdkLoadError, type GoogleSignIn } from '../platform.js';

/** Google's hosted Identity Services client. */
export const GOOGLE_GIS_URL = 'https://accounts.google.com/gsi/client';

/** The part of `google.accounts.id` this app uses. */
export interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    nonce: string;
    callback: (response: { credential?: unknown }) => void;
    ux_mode: 'popup';
    use_fedcm_for_prompt: boolean;
    auto_select: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: { type: 'standard'; theme: 'outline'; size: 'large'; text: 'signin_with'; width: number; locale?: string },
  ): void;
}

type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleAccountsId } } };

/** Inject Google's script once; a failed load is retried on the next render. */
export function gisLoader(win: Window): () => Promise<GoogleAccountsId> {
  let loading: Promise<GoogleAccountsId> | null = null;
  const sdk = (): GoogleAccountsId | undefined => (win as GoogleWindow).google?.accounts?.id;
  return () => {
    const ready = sdk();
    if (ready) return Promise.resolve(ready);
    loading ??= new Promise<GoogleAccountsId>((resolve, reject) => {
      const script = win.document.createElement('script');
      script.src = GOOGLE_GIS_URL;
      script.async = true;
      script.addEventListener('load', () => {
        const id = sdk();
        if (id) resolve(id);
        else reject(new GoogleSdkLoadError('google.accounts.id missing after load'));
      });
      script.addEventListener('error', () => reject(new GoogleSdkLoadError('Google Identity Services failed to load')));
      win.document.head.append(script);
    }).catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}

/** GIS buttons take a pixel width between 200 and 400: match the column the Apple button fills. */
export function buttonWidth(parent: HTMLElement): number {
  const width = Math.round(parent.getBoundingClientRect().width);
  return Math.min(400, Math.max(200, width || 320));
}

export function createGoogleWebSignIn(
  config: GoogleConfig,
  load: () => Promise<GoogleAccountsId>,
  locale?: () => string,
): GoogleSignIn {
  return {
    async renderButton(parent, request, onCredential) {
      const id = await load();
      // Only `openid email profile` are implied; no scopes, no stored Google tokens (ADR-011 §1).
      id.initialize({
        client_id: config.clientId,
        nonce: request.nonce,
        callback: (response) => {
          if (typeof response.credential === 'string' && response.credential !== '') onCredential(response.credential);
        },
        ux_mode: 'popup',
        use_fedcm_for_prompt: true,
        auto_select: false,
      });
      parent.replaceChildren();
      id.renderButton(parent, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        width: buttonWidth(parent),
        ...(locale ? { locale: locale() } : {}),
      });
    },
  };
}
