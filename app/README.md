# @capcollector/app

One Vite + TypeScript bundle (ADR-001): wrapped with Capacitor for the iPhone and Android (bundle / applicationId
`com.naevatec.collectors`, name CapCollector; Android since CAP-112, ADR-011 §4) and served statically for the Mac
browser. Configuration comes from `app/.env.local` (see
`.env.example`): `VITE_API_URL`, `VITE_APPLE_SERVICE_ID` + `VITE_APPLE_REDIRECT_URI`, `VITE_WEB_URL`.

```bash
npm run dev -w @capcollector/app     # Vite dev server
npm run build -w @capcollector/app   # dist/ (web build, also what Capacitor copies into the iOS app)
```

## Icon and launch screen

The sources are the SVGs in `app/design/` — the cap-with-dot mark of the sign-in screen on the warm ground of
SCREENS.md § Visual system (`#FAFAF7` ground, `#1B1A17` ink, `#B8651B` copper):

- `icon.svg` → `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` — one 1024 × 1024 icon (Xcode 15+
  single size), opaque RGB, no text.
- `splash.svg` / `splash-dark.svg` → `Splash.imageset` — 2732² universal for every scale, light and dark appearance;
  `LaunchScreen.storyboard` shows it with aspect fill, so only background is cropped.

- Android (CAP-112): an adaptive icon — the ink background (`values/ic_launcher_background.xml`), the copper cap as
  a vector foreground and a white monochrome layer for themed icons (`drawable/ic_launcher_{foreground,monochrome}.xml`,
  the paths of `icon.svg`), plus legacy square and round PNGs in `mipmap-*`. The launch screen is the ground colour
  with the cap (Android 12+ SplashScreen API, `values/styles.xml`).

After editing an SVG, re-render and commit the outputs (needs `rsvg-convert`: `brew install librsvg`):

```bash
npx tsx app/design/render.ts
```

## Xcode names

Capacitor hardcodes the project file `ios/App/App.xcodeproj`, the target folder `ios/App/App/` and `CapApp-SPM`, so
those keep the name `App` (renaming them breaks `cap sync` / `cap open`). The native target, the product
(`CapCollector.app`, Swift module `CapCollector`) and the shared scheme
(`App.xcodeproj/xcshareddata/xcschemes/CapCollector.xcscheme`, also `ios.scheme` in `capacitor.config.ts`) are
`CapCollector` (CAP-94). The home-screen name is `CFBundleDisplayName` in `Info.plist`.

## Android names

Capacitor's CLI expects the Gradle module `android/app` (and `MainActivity` in the `applicationId` package), so those
keep their names, as `App.xcodeproj` does on iOS (CAP-94). The Gradle root project (`rootProject.name` in
`android/settings.gradle`), `app_name` and `title_activity_main` (`res/values/strings.xml`) are **CapCollector**
(CAP-112). The `applicationId` is `com.naevatec.collectors`, from `capacitor.config.ts`.

## Signing team

The tracked project has no Apple Team ID (CAP-104). The target's base configuration `ios/App/CapCollector.xcconfig`
includes `ios/App/Local.xcconfig`, which is gitignored. Create it once per checkout with your team (Apple Developer →
Membership details):

```bash
cp app/ios/App/Local.xcconfig.example app/ios/App/Local.xcconfig   # then set DEVELOPMENT_TEAM = <your team id>
```

Without it the simulator build still works, but signing for a device or archiving asks for a team.

## Versions

- **Marketing version** (`MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`, shown as the App Store
  version) = the release tag being shipped: `v0.5.0-v2` → `0.5.0`, `v0.8.0-v3` → `0.8.0`, `v1.0.0-v4` → `1.0.0`.
- **Build number** (`CURRENT_PROJECT_VERSION`) goes up by one for every archive uploaded, and starts again at `1` when
  the marketing version changes. App Store Connect refuses a build number it has already seen for that version.
- Change both in Xcode (target _CapCollector_ → General → Identity) or in `project.pbxproj` (Debug and Release); commit the
  change with the release. Deriving them from `package.json` would need integrator scripts and is not done.

## Release (TestFlight)

What Edu does by hand; no agent archives or uploads.

1. On `main` at the release tag, with `app/.env.local` holding the production values: `VITE_API_URL=<ApiUrl>`,
   `VITE_WEB_URL=<WebUrl>` and the Apple web values.
2. Build the bundle and copy it into the iOS project:
   ```bash
   npm ci
   npm run build -w @capcollector/app
   cd app && npx cap sync ios
   ```
3. `npx cap open ios` (or open `app/ios/App/App.xcodeproj` in Xcode). Check the version and build number (§ Versions).
4. Scheme _CapCollector_, destination **Any iOS Device (arm64)**, then **Product → Archive**.
5. Organizer → **Distribute App → TestFlight & App Store** (or _TestFlight Internal Only_) → Upload.
6. In App Store Connect, once processed: export compliance is already answered (`ITSAppUsesNonExemptEncryption =
false`: the app only uses HTTPS), add the build to the internal testing group, and install it from TestFlight on
   the iPhone. Check the icon and the launch screen (light and dark).

What App Store review reads from the project:

- `ios/App/App/Info.plist`: display name CapCollector; camera / photo library / photo add usage strings (CAP-21);
  `ITSAppUsesNonExemptEncryption = false`; `UIRequiresFullScreen`; portrait only on iPhone; `LSRequiresIPhoneOS`.
- `ios/App/App/PrivacyInfo.xcprivacy`: no tracking and no tracking domains. Collected data: photos (the user's own
  caps), the user ID (Apple `sub`) and coarse location (CAP-100), all linked to the user, used only for app
  functionality. Coarse location: `PlaceNamePlugin.swift` asks "when in use" permission, takes one reduced-accuracy
  fix and turns it into a place name on the device (`CLGeocoder`) to pre-fill "Where acquired"; only that name is
  saved with the cap, the coordinates are never stored or sent. In App Store Connect: _Location → Coarse Location_,
  linked to the user, _App Functionality_, not used for tracking. Required-reason
  APIs: UserDefaults `CA92.1` (`@capacitor/preferences`) and file timestamps `C617.1` (`@capacitor/filesystem`). The
  answers in App Store Connect's privacy questionnaire must match this file.

### Where the sign-in values live

- **App ID** `com.naevatec.collectors` with _Sign in with Apple_, and the **Services ID** for the web flow (e.g.
  `com.naevatec.collectors.web`, with the CloudFront web URL as return URL): Apple Developer → Certificates,
  Identifiers & Profiles (doc/plans/CAP-22-sign-in.md).
- The web build reads the Services ID and its return URL from `VITE_APPLE_SERVICE_ID` / `VITE_APPLE_REDIRECT_URI`.
- The API accepts tokens for the audiences in SSM `/cap/<inst>/<stage>/apple-client-ids` (the bundle ID for the
  iPhone and the Services ID for the web), and only the Apple `sub`s in `/cap/<inst>/<stage>/allowed-apple-subs`
  (infra/README.md § Settings).

### Google sign-in

Sign in with Google (ADR-011, CAP-111) shows on the web next to Apple. It's never offered on iOS, and Android uses
the native Credential Manager sheet (CAP-113, § Google sign-in on Android). The button only appears when the build has
a Google client id.

1. **Google Cloud → APIs & Services → OAuth consent screen:** user type _External_, publishing status **Testing**,
   with the owner's Google account as the only test user. No scopes beyond the default `openid email profile`.
2. **Credentials → Create credentials → OAuth client ID → Web application:** add the web origin(s) as **Authorized
   JavaScript origins** (the stack's `<WebUrl>`, plus `http://localhost:5173` for `npm run dev`). No redirect URIs:
   Google Identity Services returns the ID token in a popup, without a redirect.
3. Put the client id (`<n>-<id>.apps.googleusercontent.com`, not a secret) in `VITE_GOOGLE_CLIENT_ID` for the web
   build. The API accepts it once it is in SSM `/cap/<inst>/<stage>/google-client-ids` (infra/README.md § Settings).
4. First sign-in: the API refuses it (403), and the screen shows your Google `sub` with a copy button. Add
   `<googleSub>=<uid>` to `/cap/<inst>/<stage>/google-identities`, where `<uid>` is your Apple `sub` (one collection
   for both providers). Then redeploy and sign in again.

### Network (ATS)

The app talks only to the API (`<ApiUrl>`, an HTTPS stack output) and to S3 presigned HTTPS URLs for the images, so App
Transport Security needs no exception: `Info.plist` has no `NSAppTransportSecurity` entry and must not get one.

## Android

The Android app is the same bundle in Capacitor's Android shell (ADR-011 §4), side-loaded as a signed APK: no Play
Store. It runs on Android 8+ (`minSdkVersion` from Capacitor 8, `android/variables.gradle`). CI has no Android SDK, so
the build is a manual check, like the iPhone one.

```bash
npm run build:shared && npm run build -w @capcollector/app   # dist/
cd app && npx cap sync android && npx cap open android      # Android Studio
```

- **What's native:** camera, files, share and preferences come from the Capacitor plugins. The place for "Where
  acquired" comes from `PlaceNamePlugin.kt` (coarse location and the on-device `Geocoder`, no Google Play services;
  the coordinates are never stored). `collectors://cap/<id>` links open the cap, and the hardware back button goes back,
  leaving the app on the Collection.
- **Permissions:** `INTERNET`, `CAMERA` and `ACCESS_COARSE_LOCATION` only. Backup is off (`allowBackup="false"`).
- **Sign-in:** Google only, through the native Credential Manager sheet (ADR-011 §3, CAP-113, § Google sign-in on
  Android below). There is no Apple sign-in on Android. A build without `VITE_GOOGLE_CLIENT_ID` offers no provider and
  the sign-in screen says so.
- **API origin:** the WebView's origin is `https://localhost` (Capacitor's default `androidScheme`). Add it to
  `app_origins` in your installation's config (infra/README.md), or the API's CORS refuses the app.

### Release APK

1. Create a keystore once, outside the repo, and keep it and its passwords safe (every update must be signed with
   the same key):

   ```bash
   keytool -genkeypair -v -keystore ~/keys/capcollector.jks -alias capcollector -keyalg RSA -keysize 4096 -validity 10000
   ```

2. In Android Studio: **Build → Generate Signed App Bundle / APK → APK**, choose that keystore, variant `release`. If
   you keep the passwords in `android/keystore.properties` for your own Gradle signing config, that file is gitignored,
   like `*.jks` and `*.keystore`. Never commit them.
3. Copy `android/app/release/app-release.apk` to the phone and install it (allow installs from that source once).
   Raise `versionCode` / `versionName` in `android/app/build.gradle` for each new APK.

### Google sign-in on Android

The Android app signs in with Google through Android Credential Manager (`GoogleSignInPlugin.kt`, CAP-113). It asks
for an ID token for the **Web** client id, the same `VITE_GOOGLE_CLIENT_ID` as the web build, so the token's `aud` is
the Web client id that the API already accepts in `google-client-ids`. Then the flow is the web one: a PKCE nonce,
`POST /auth/google`, and the same `google-identities` mapping.

1. **Google Cloud → Credentials → Create credentials → OAuth client ID → Android**, once per signing key: package name
   `com.naevatec.collectors` and the key's SHA-1. This client is never referenced in code, but Google only issues
   tokens to an app whose package and signature match one. Read the SHA-1 of the debug keystore and of your release
   keystore:

   ```bash
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
   keytool -list -v -keystore ~/keys/capcollector.jks -alias capcollector
   ```

2. Build the app with `VITE_GOOGLE_CLIENT_ID` set (the Web client id), then sync: `npx cap sync android`.
3. First sign-in: the API refuses it (403) and the screen shows your Google `sub`. If you already mapped it for the web,
   it is the same `sub`, and the same collection opens.
