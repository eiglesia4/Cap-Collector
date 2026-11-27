# @capcollector/app

One Vite + TypeScript bundle (ADR-001): wrapped with Capacitor for the iPhone (bundle `com.naevatec.collectors`, name
CapCollector) and served statically for the Mac browser. Configuration comes from `app/.env.local` (see
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

After editing an SVG, re-render and commit the PNGs (needs `rsvg-convert`: `brew install librsvg`):

```bash
npx tsx app/design/render.ts
```

## Xcode names

Capacitor hardcodes the project file `ios/App/App.xcodeproj`, the target folder `ios/App/App/` and `CapApp-SPM`, so
those keep the name `App` (renaming them breaks `cap sync` / `cap open`). The native target, the product
(`CapCollector.app`, Swift module `CapCollector`) and the shared scheme
(`App.xcodeproj/xcshareddata/xcschemes/CapCollector.xcscheme`, also `ios.scheme` in `capacitor.config.ts`) are
`CapCollector` (CAP-94). The home-screen name is `CFBundleDisplayName` in `Info.plist`.

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

Sign in with Google (ADR-011, CAP-111) shows on the web next to Apple. It's never offered on iOS, and Android gets its
own native flow (CAP-113). The button only appears when the build has a Google client id.

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
