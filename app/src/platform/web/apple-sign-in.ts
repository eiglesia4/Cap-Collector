// Web flow of Sign in with Apple (ADR-008 §4, CAP-22): Apple's JS SDK (`AppleID.auth`) loaded on demand, in popup
// mode, with the Service ID and return URL from config (doc/plans/CAP-22-sign-in.md lists the values Edu
// registers in the Apple Developer portal). Used by the Mac/web build and, until the native plugin is installed,
// by the iPhone app as well.
import type { AppleConfig } from '../../config.js';
import {
  AppleSdkLoadError,
  AppleSignInUnavailableError,
  type AppleCredential,
  type AppleSignInRequest,
} from '../platform.js';

/** Apple's hosted SDK (Sign in with Apple JS, v1). */
export const APPLE_SDK_URL = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

/** The part of `AppleID.auth` this app uses. */
export interface AppleIdAuth {
  init(config: {
    clientId: string;
    scope: string;
    redirectURI: string;
    state: string;
    nonce: string;
    usePopup: boolean;
  }): void;
  signIn(): Promise<{ authorization?: { id_token?: unknown; code?: unknown; state?: unknown } }>;
}

/** Errors Apple's popup reports when the user backs out. */
const CANCEL_ERRORS = new Set(['popup_closed_by_user', 'user_cancelled_authorize', 'user_trigger_new_signin_flow']);

function appleError(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'string') {
    return error.error;
  }
  return null;
}

/** Inject the SDK script once; a failed load is retried on the next attempt. */
export function scriptLoader(win: Window): () => Promise<AppleIdAuth> {
  let loading: Promise<AppleIdAuth> | null = null;
  const sdk = (): AppleIdAuth | undefined => (win as Window & { AppleID?: { auth?: AppleIdAuth } }).AppleID?.auth;
  return () => {
    const ready = sdk();
    if (ready) return Promise.resolve(ready);
    loading ??= new Promise<AppleIdAuth>((resolve, reject) => {
      const script = win.document.createElement('script');
      script.src = APPLE_SDK_URL;
      script.async = true;
      script.addEventListener('load', () => {
        const auth = sdk();
        if (auth) resolve(auth);
        else reject(new AppleSdkLoadError('AppleID.auth missing after load'));
      });
      script.addEventListener('error', () => reject(new AppleSdkLoadError('Apple JS SDK failed to load')));
      win.document.head.append(script);
    }).catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}

export function createAppleWebSignIn(
  config: AppleConfig | null,
  load: () => Promise<AppleIdAuth>,
): (request: AppleSignInRequest) => Promise<AppleCredential | null> {
  return async (request) => {
    if (!config) throw new AppleSignInUnavailableError('Sign in with Apple is not configured for this build');
    const auth = await load();
    // Name and e-mail are not requested: the API keys the allow-list on `sub` only (ADR-008 §4).
    auth.init({
      clientId: config.serviceId,
      scope: '',
      redirectURI: config.redirectUri,
      state: request.state,
      nonce: request.nonce,
      usePopup: true,
    });
    let response: Awaited<ReturnType<AppleIdAuth['signIn']>>;
    try {
      response = await auth.signIn();
    } catch (error) {
      const code = appleError(error);
      if (code !== null && CANCEL_ERRORS.has(code)) return null;
      throw new Error(`Sign in with Apple failed: ${code ?? 'unknown error'}`, { cause: error });
    }
    const { id_token: identityToken, code, state } = response.authorization ?? {};
    if (typeof identityToken !== 'string' || identityToken === '') {
      throw new Error('Sign in with Apple returned no identity token');
    }
    return {
      identityToken,
      ...(typeof code === 'string' && code !== '' && { authorizationCode: code }),
      ...(typeof state === 'string' && { state }),
    };
  };
}
