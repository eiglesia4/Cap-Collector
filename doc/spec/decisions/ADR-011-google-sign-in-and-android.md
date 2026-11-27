# ADR-011: Sign in with Google, and an Android build

- **Status:** Accepted
- **Date:** 2026-11-27
- **Amends:** ADR-001 (platforms) and ADR-008 §4 (auth)

## Context
The owner wants two more pieces to close a fully working personal app: sign in with Google, and the app on Android.
ADR-001 left Android "possible later at near-zero cost": Capacitor targets it from the same bundle. ADR-008 §4 made
Sign in with Apple the only provider. That provider can't be used natively on Android.

## Decision
1. **Google is a second identity provider, with the same pattern as Apple.**
   - New route `POST /auth/google` with `{ idToken, codeVerifier }`. The client asks Google for an ID token with
     `nonce = base64url(SHA-256(codeVerifier))`. The API verifies the token:
     - the signature against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached);
     - `iss` = `accounts.google.com` or `https://accounts.google.com`;
     - `aud` in the `google-client-ids` setting, and `exp`;
     - `email_verified` = true;
     - `nonce` against the verifier.
   - It then issues the same `Session` as `/auth/apple`. No Cognito, no stored Google tokens, no scopes beyond
     `openid email profile`.
2. **One collection across providers.** The user id (`uid`, `USER#<uid>`) stays what it is: the owner's Apple `sub`.
   - A new setting, `google-identities`, maps Google subs to uids: `googleSub=uid` pairs, comma-separated. A Google
     sign-in is allowed only when its `sub` is in that map, so the map is the Google allow-list. The owner maps his
     Google `sub` to his Apple `sub`, and both sign-ins open the same collection.
   - When the `sub` isn't in the map, the API answers 403 with the `sub` in the Problem body, as for Apple, so the owner
     can add it.
   - A Google-only installation (no Apple account) maps a Google `sub` to itself: `uid` = that sub.
3. **Where each button shows.**
   - **Web:** Apple and Google. Google uses Google Identity Services in the browser, which returns an ID token
     directly, without a redirect.
   - **Android:** Google only, through an in-app native plugin on Android Credential Manager (`androidx.credentials` +
     Google ID). Sign in with Apple isn't offered there.
   - **iOS:** Apple only, unchanged. Google on iOS can be added later without contract changes.
4. **Android is a Capacitor platform of the same bundle.**
   - `@capacitor/android` (same major as the iOS one); `app/android/`; `applicationId` = the bundle id.
   - The visible name and the Gradle root project are **CapCollector**. Capacitor's `app` module name stays, because
     the CLI expects it; this follows the lesson of CAP-94.
   - The camera, filesystem, preferences and share plugins already support Android. The place-from-GPS plugin gets an
     Android twin: coarse location and the on-device `android.location.Geocoder`, still with no coordinates stored.
   - `collectors://` deep links come in through an intent filter. The hardware back button navigates back.
   - Chromium's WebView encodes WebP itself, so ADR-010's fallback isn't loaded there.
   - Distribution: a signed APK built by the owner (Android Studio, local keystore, never in git) and side-loaded. No
     Play Store, as with TestFlight being optional on iOS.
5. **CORS:** the Android WebView origin is `https://localhost` (Capacitor's default `androidScheme`). It must be in the
   target's `app_origins`.

## Consequences
- **Contracts v0.5.0:** `GoogleSignInRequest`, plus the route in `ROUTES` and the OpenAPI. Because `ROUTES` drives the
  API (T-api-039) and infra (T-infra-016) checks, the contract, its handler and its wiring land as a **stack of three
  PRs merged together** (contracts → api → infra). CI is checked on the top of the stack.
- **New settings:** `google-client-ids` and `google-identities`. The owner creates a Google Cloud OAuth consent
  screen in testing mode, with himself as test user, plus a Web client and an Android client (package name + the
  SHA-1 of his signing key). None of these are secrets. Only the client ids go into settings and app config.
- **Cost:** still ≈ 0. The JWKS fetch is cached in the Lambda; Credential Manager and Identity Services are free.
- **CI** can't build Android (no SDK in CI, as with Xcode for iOS). The Android build is a manual check, like
  the iPhone one.
