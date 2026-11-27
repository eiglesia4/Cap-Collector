// The in-app native Google sign-in plugin (CAP-113; ADR-011 §1, §3): app/android/app/src/main/java/…/
// GoogleSignInPlugin.kt, registered by MainActivity under the JS name `GoogleSignIn` (the in-app pattern of CAP-65; no
// npm dependency). One call, `signIn({ serverClientId, nonce })`: Android Credential Manager with a Google ID option
// for the Web client id, the PKCE nonce copied into the ID token. It resolves `{ idToken }`, `{ cancelled: true }` or
// `{ error }` and never rejects; the token is never logged.
import { registerPlugin } from '@capacitor/core';

export interface GoogleSignInPlugin {
  signIn(options: { serverClientId: string; nonce: string }): Promise<Record<string, unknown>>;
}

export const GoogleSignIn = registerPlugin<GoogleSignInPlugin>('GoogleSignIn');
