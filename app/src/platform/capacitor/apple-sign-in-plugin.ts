// The in-app native Sign in with Apple plugin (CAP-65; ADR-008 §4): app/ios/App/App/AppleSignInPlugin.swift,
// registered by MainViewController under the JS name `AppleSignIn`. It replaces @capacitor-community/apple-sign-in
// (Capacitor 7 only). No scopes are requested; the nonce is the PKCE one, passed through unchanged.
import { registerPlugin } from '@capacitor/core';

export interface AppleSignInAuthorizeOptions {
  /** base64url(SHA-256(codeVerifier)), copied by Apple into the identity token's `nonce` claim. */
  readonly nonce: string;
}

export interface AppleSignInAuthorization {
  readonly identityToken: string;
  readonly authorizationCode?: string;
  /** Apple's stable user id (the token's `sub`). */
  readonly user: string;
}

export interface AppleSignInPlugin {
  authorize(options: AppleSignInAuthorizeOptions): Promise<AppleSignInAuthorization>;
}

/** Rejection code of a sheet the user closed (`ASAuthorizationError.canceled`). */
export const APPLE_CANCELLED = 'cancelled';

export const AppleSignIn = registerPlugin<AppleSignInPlugin>('AppleSignIn');
