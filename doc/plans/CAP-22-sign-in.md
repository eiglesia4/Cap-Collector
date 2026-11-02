# CAP-22: pantalla Sign in with Apple — flujo web (PKCE) en Mac, fallback en iPhone, sesión y cierre de sesión

| Jira                                                   | Epic  | Rama             | Agente    | Estado      |
| ------------------------------------------------------ | ----- | ---------------- | --------- | ----------- |
| [CAP-22](https://naevatec.atlassian.net/browse/CAP-22) | CAP-4 | `CAP-22-sign-in` | `dev-app` | En revisión |

## Contexto

ADR-008 §4: Sign in with Apple + PKCE, allow-list de un solo `sub`, JWT de sesión + refresh token, sin Cognito.
La API está en `main` desde CAP-19 (`POST /auth/apple`, `POST /auth/refresh`). Decisión de contrato del arquitecto
(CAP-19, retransmitida en CAP-22): la app genera `codeVerifier` (43–128 caracteres), pasa a Apple
`nonce = base64url(SHA-256(codeVerifier))` y envía `{ identityToken, authorizationCode?, codeVerifier }`; el refresh
envía `{ refreshToken }`. La app base (router, adaptador `platform/`, almacén de sesión, cliente API) es de CAP-21.

## Pasos

| #   | Paso                                                                                             | Estado |
| --- | ------------------------------------------------------------------------------------------------ | ------ |
| 1   | `auth/pkce.ts`: verifier (48 bytes → 64 caracteres), nonce S256, `state` aleatorio               | Hecho  |
| 2   | `platform.signInWithApple` + `supportsNativeAppleSignIn`; web con Apple JS (popup); iPhone → web | Hecho  |
| 3   | Config `VITE_APPLE_SERVICE_ID` + `VITE_APPLE_REDIRECT_URI` (ambas o ninguna, https)              | Hecho  |
| 4   | Cliente API: `signInWithApple`, `refresh` público (5xx conserva la sesión)                       | Hecho  |
| 5   | `auth/sign-in.ts`: flujo (cancelar, `state`, 403, red, sin configurar) y `restoreSession`        | Hecho  |
| 6   | Pantalla `/sign-in`, guarda de rutas en `app.ts`, «Sign out» en Settings                         | Hecho  |
| 7   | Tests T-app-019…029                                                                              | Hecho  |

## Valores que Edu configura en Apple Developer

En **Certificates, Identifiers & Profiles**:

1. **App ID** `com.naevatec.collectors` con la capacidad _Sign in with Apple_ (ya existe para la app iOS).
2. **Services ID** (p. ej. `com.naevatec.collectors.web`), agrupado bajo el App ID anterior, con _Sign in with Apple_
   activado y en _Configure_:
   - **Domains and Subdomains**: el dominio de CloudFront del stack web (CAP-16), p. ej. `d1234abcd.cloudfront.net`
     (sin `https://`).
   - **Return URLs**: la `WebUrl` de CloudFront con barra final, p. ej. `https://d1234abcd.cloudfront.net/`.
3. En la API (SSM, CAP-19): `CAP_APPLE_CLIENT_IDS = com.naevatec.collectors,com.naevatec.collectors.web`
   (el bundle id para el token nativo del iPhone y el Services ID para el token web).

En el build de la app (`app/.env.local` o el entorno de `npm run deploy:web`):

```bash
VITE_API_URL=https://<api-id>.execute-api.<region>.amazonaws.com
VITE_APPLE_SERVICE_ID=com.naevatec.collectors.web
VITE_APPLE_REDIRECT_URI=https://d1234abcd.cloudfront.net/
```

Apple no acepta `localhost` ni `http` como Return URL: el flujo web solo funciona servido desde CloudFront. En
local (`npm run dev` + `npm run api:local`, que con `CAP_STAGE=local` no exige token) se entra con el botón
«Continue without signing in (development)», que solo aparece en builds de desarrollo y no guarda nada.

## Preguntas abiertas y decisiones

| #   | Paso | Pregunta                                                        | Recomendación / decisión                                                                                                                                   |
| --- | ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 2    | ¿Cómo entra el iPhone sin `@capacitor-community/apple-sign-in`? | Lo dice la historia: mismo popup Apple JS, detrás de `supportsNativeAppleSignIn() = false`. Plugin pedido al integrador (Pending). (2026-11-02)            |
| Q2  | 2    | ¿PKCE `code_challenge` o nonce?                                 | Apple JS no acepta `code_challenge`; se usa el nonce S256 decidido por el arquitecto en CAP-19. (2026-11-02)                                               |
| Q3  | 5    | Refresh al arrancar: ¿bloquea el primer render?                 | No: se monta la app y se refresca en segundo plano; comparte la llamada con cualquier 401 en curso. Rechazo → sign-in; red/5xx → se conserva. (2026-11-02) |
| Q4  | 6    | ¿Se piden nombre y e-mail a Apple?                              | No (`scope: ''`): la allow-list usa solo `sub`. (2026-11-02)                                                                                               |

## Notas

- **Riesgo del fallback en iPhone:** el popup de Apple JS dentro de WKWebView (`window.open` + `postMessage`) puede no
  volver a la app; si al probar `npx cap run ios` no funciona, el «Done when» del iPhone espera al plugin nativo.
  Con el plugin, la implementación Capacitor de `signInWithApple` pasa el mismo `nonce` hasheado a la hoja nativa.
- Al pulsar «Sign out» solo se borra la sesión local: la API no tiene endpoint de revocación (openapi v0.1).
