# OBULU — Android app (Capacitor)

The Android app is a Capacitor WebView shell around the **same** web build
(`web/dist`) talking to the **same** backend API. There is no separate
native codebase. The APK has **not** been built yet — no Android SDK or
signing keys exist in this environment. Follow these steps on a machine
with the tooling installed.

## Prerequisites (your machine)

1. **Node.js 20+** and npm.
2. **Java JDK 17** (required by the Android Gradle plugin).
3. **Android Studio** (includes the Android SDK + platform tools), or the
   standalone SDK command-line tools.
4. Set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to your SDK location and add
   `platform-tools` to `PATH`.
5. Accept SDK licenses: `yes | sdkmanager --licenses`.

## Steps

```bash
# 1. Build the web app (production)
cd obulu/web
npm install
npm run build          # outputs web/dist/

# 2. Install Capacitor tooling (first time only)
npm install -D @capacitor/cli
npx cap init "OBULU" com.obulu.app --web-dir=dist
# (capacitor.config.ts already exists in web/ — `cap init` will respect it;
#  answer prompts to match: appId com.obulu.app, webDir dist)

# 3. Add the Android platform (first time only)
npm install @capacitor/android
npx cap add android    # generates obulu/web/android/

# 4. Point the app at the production backend.
#    Capacitor serves from https, so the API must be a public HTTPS URL.
#    Rebuild web with the production API URL:
#    (PowerShell)  $env:VITE_API_URL="https://<api-host>"; npm run build
#    (bash)        VITE_API_URL="https://<api-host>" npm run build
npx cap sync android   # copies web/dist into the native project

# 5. Open in Android Studio
npx cap open android
```

## Generate a signed release APK (in Android Studio)

1. **Create a keystore** (first time only):
   `Build → Generate Signed Bundle / APK → Create new…` — fill in key
   alias, passwords, validity (25+ years). **Back up the `.jks` file and
   passwords** — losing them means you can never update the app.
2. `Build → Generate Signed Bundle / APK → APK → release`.
3. Select your keystore, enter passwords → Finish.
4. Find `obulu/web/android/app/release/app-release.apk`.

(Or via Gradle: `cd obulu/web/android && ./gradlew assembleRelease` with
signing configured in `android/app/build.gradle` / `keystore.properties` —
see Android's official "Sign your app" docs.)

## Install on a device

1. Enable **Install unknown apps** for your file manager/browser
   (Settings → Apps → Special app access).
2. Copy `app-release.apk` to the phone and tap it, or:
   `adb install app-release.apk`.
3. The app icon shows OBULU branding; it loads the bundled web UI and
   calls `VITE_API_URL` for data.

## Notes / limitations

- The app requires internet access (fixtures/predictions come from the
  backend). There is no offline mode.
- For a debug APK during development: in Android Studio choose the
  `debug` variant instead of `release` (no keystore needed, not for
  distribution).
- Publishing to Google Play additionally requires a Play Console
  account, an **Android App Bundle** (`.aab`, same signing flow), a
  privacy policy URL, and Play's data-safety form. OBULU collects no
  personal data (no accounts), which simplifies the form — but the
  listing, review, and rollout are done by you in Play Console.
- After any web change: `npm run build && npx cap sync android`.
