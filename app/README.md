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

## Versions

- **Marketing version** (`MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`, shown as the App Store
  version) = the release tag being shipped: `v0.5.0-v2` → `0.5.0`, `v0.8.0-v3` → `0.8.0`, `v1.0.0-v4` → `1.0.0`.
- **Build number** (`CURRENT_PROJECT_VERSION`) goes up by one for every archive uploaded, and starts again at `1` when
  the marketing version changes. App Store Connect refuses a build number it has already seen for that version.
- Change both in Xcode (target _App_ → General → Identity) or in `project.pbxproj` (Debug and Release); commit the
  change with the release. Deriving them from `package.json` would need integrator scripts and is not done.

## Release (TestFlight)

What Edu does by hand; no agent archives or uploads.

1. On `main` at the release tag, with `app/.env.local` holding the production values: `VITE_API_URL=https://api.caps.naevatec.com`,
   `VITE_WEB_URL=https://caps.naevatec.com` and the Apple web values.
2. Build the bundle and copy it into the iOS project:
   ```bash
   npm ci
   npm run build -w @capcollector/app
   cd app && npx cap sync ios
   ```
3. `npx cap open ios` (or open `app/ios/App/App.xcodeproj` in Xcode). Check the version and build number (§ Versions).
4. Scheme _App_, destination **Any iOS Device (arm64)**, then **Product → Archive**.
5. Organizer → **Distribute App → TestFlight & App Store** (or _TestFlight Internal Only_) → Upload.
6. In App Store Connect, once processed: export compliance is already answered (`ITSAppUsesNonExemptEncryption =
false`: the app only uses HTTPS), add the build to the internal testing group, and install it from TestFlight on
   the iPhone. Check the icon and the launch screen (light and dark).

What App Store review reads from the project:

- `ios/App/App/Info.plist`: display name CapCollector; camera / photo library / photo add usage strings (CAP-21);
  `ITSAppUsesNonExemptEncryption = false`; `UIRequiresFullScreen`; portrait only on iPhone; `LSRequiresIPhoneOS`.
- `ios/App/App/PrivacyInfo.xcprivacy`: no tracking and no tracking domains. Collected data: photos (the user's own
  caps) and the user ID (Apple `sub`), both linked to the user, used only for app functionality. Required-reason
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

### Network (ATS)

The app talks only to `https://api.caps.naevatec.com` (the API) and to S3 presigned HTTPS URLs for the images, so App
Transport Security needs no exception: `Info.plist` has no `NSAppTransportSecurity` entry and must not get one.
