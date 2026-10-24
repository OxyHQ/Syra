const pkg = require('./package.json');
const fs = require('fs');
const path = require('path');
const { oxySplashScreenPlugin } = require('@oxy.so/expo-splash/config');

// FCM config lives at the monorepo root and is only present in CI / release
// setups (or via the GOOGLE_SERVICES_JSON env, as in Mention). Local dev-client
// builds don't have it — include it only when it actually exists so
// `expo prebuild` doesn't fail on a missing file.
const googleServicesJson =
  process.env.GOOGLE_SERVICES_JSON || path.resolve(__dirname, '../../google-services.json');
const hasGoogleServices = fs.existsSync(googleServicesJson);

module.exports = function (_config) {
  /**
   * App version number. Should be incremented as part of a release cycle.
   */
  const VERSION = pkg.version;

  /**
   * Uses built-in Expo env vars
   *
   * @see https://docs.expo.dev/build-reference/variables/#built-in-environment-variables
   */
  const PLATFORM = process.env.EAS_BUILD_PLATFORM;

  const IS_TESTFLIGHT = process.env.EXPO_PUBLIC_ENV === 'testflight';
  const IS_PRODUCTION = process.env.EXPO_PUBLIC_ENV === 'production';
  const IS_DEV = !IS_TESTFLIGHT && !IS_PRODUCTION;

  return {
    expo: {
      name: 'Syra',
      slug: 'syra',
      version: VERSION,
      orientation: 'portrait',
      icon: './assets/images/app-icon.png',
      scheme: 'syra',
      userInterfaceStyle: 'automatic',
      experiments: {
        typedRoutes: true,
        reactCompiler: true,
        // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
        // only: in a production export it keeps the requires of dead platform branches
        // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
        // the web bundle. The CLI sets NODE_ENV before it reads this config.
        noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
      },
      ios: {
        supportsTablet: true,
        bundleIdentifier: 'com.syra.ios',
      },
      android: {
        adaptiveIcon: {
          foregroundImage: './assets/images/app-icon_foreground.png',
          backgroundImage: './assets/images/app-icon_background.png',
          monochromeImage: './assets/images/app-icon_monochrome.png',
        },
        permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
        // Must match google-services.json package_name
        package: 'com.syra.app',
        // Point to your google-services.json for FCM (only when present —
        // absent in local dev-client builds).
        ...(hasGoogleServices ? { googleServicesFile: googleServicesJson } : {}),
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                host: 'syra.fm',
              },
              {
                scheme: 'https',
                host: 'oxy.so',
              },
              IS_DEV && {
                scheme: 'http',
                host: 'localhost:4120',
              },
            ],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ],
        softwareKeyboardLayoutMode: 'pan',
      },
      web: {
        bundler: 'metro',
        output: 'single',
        favicon: './assets/images/favicon.png',
        manifest: './public/manifest.json',
        meta: {
          viewport: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
          themeColor: '#72184D',
          appleMobileWebAppCapable: 'yes',
          appleMobileWebAppStatusBarStyle: 'default',
          appleMobileWebAppTitle: 'Syra',
          applicationName: 'Syra',
          msapplicationTileColor: '#72184D',
          msapplicationConfig: '/browserconfig.xml',
        },
        build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
        // Metro configuration is handled in metro.config.js
        // Removing duplicate configuration here to avoid conflicts
      },
      // Build the plugins array dynamically so we can exclude certain
      // native-only plugins (like expo-notifications) from web builds.
      plugins: (() => {
        const base = [
          // SDK 58 turns on async routes for web by default; keep SDK 57's single
          // web bundle (the bundle budget is measured against that shape).
          ['expo-router', { asyncRoutes: { web: false } }],
          // Native OS splash (Oxy family "Instagram, from Meta" pattern): Syra's
          // OWN equalizer logo (white on transparent) centered on the shared dark
          // brand background, with the Oxy symbol pinned to the bottom.
          // `oxySplashScreenPlugin` builds the `expo-splash-screen` tuple with the
          // Oxy-standard defaults; the bare `@oxy.so/expo-splash` entry (bundled Oxy
          // asset) MUST follow it immediately to add the bottom branding — the
          // ordering is load-bearing.
          oxySplashScreenPlugin({
            image: './assets/images/splash-logo.png',
            imageWidth: 176,
            backgroundColor: '#0B0B0F',
          }),
          '@oxy.so/expo-splash',
          [
            'expo-camera',
            {
              cameraPermission: 'Allow $(PRODUCT_NAME) to access your camera',
              microphonePermission: 'Allow $(PRODUCT_NAME) to access your microphone',
              recordAudioAndroid: true,
            },
          ],
          'expo-image',
          'expo-image-picker',
          'expo-video',
          'expo-audio',
          // Dictation and voice calls with Alia (`@alia.onl/sdk`) recognise speech
          // on the device; the plugin writes the two iOS purpose strings and the
          // Android RECORD_AUDIO permission.
          [
            'react-native-audio-api',
            {
              iosMicrophonePermission:
                'Allow $(PRODUCT_NAME) to hear what you dictate and say to Alia.',
              iosBackgroundMode: false,
              androidForegroundService: false,
              androidPermissions: ['android.permission.RECORD_AUDIO'],
            },
          ],
          [
            'expo-secure-store',
            {
              configureAndroidBackup: true,
              faceIDPermission: 'Allow $(PRODUCT_NAME) to access your Face ID biometric data.',
            },
          ],
          [
            'expo-font',
            {
              fonts: [
                './assets/fonts/inter/InterVariable.ttf',
                './assets/fonts/inter/InterVariable-Italic.ttf',
              ],
            },
          ],
          'react-native-compressor',
          [
            '@bitdrift/react-native',
            {
              networkInstrumentation: true,
            },
          ],
          [
            'expo-build-properties',
            {
              ios: {
                deploymentTarget: '16.4',
              },
              android: {
                // compileSdk / targetSdk / build tools come from the Expo SDK
                // template (SDK 58: 37 / 36 / 37.0.0). SDK 58's Expo modules
                // require compileSdk 37; a pinned 36 fails the release build
                // in :expo:checkReleaseAarMetadata.
                enableProguardInReleaseBuilds: true,
                enableShrinkResourcesInReleaseBuilds: true,
                useLegacyPackaging: false,
                extraProguardRules: [
                  '# @livekit/react-native-webrtc 144.2.0 (the version @livekit/react-native',
                  '# 3.0.0 requires) moved to the PREFIXED WebRTC build (livekit.org.*) but its',
                  '# consumer rules still keep org.jni_zero.**. R8 then strips',
                  '# livekit.org.jni_zero.JniInit, and libjingle_peerconnection aborts in',
                  '# JNI_OnLoad at startup. Fixed upstream in livekit/react-native-webrtc#107',
                  '# (150.1.0); drop with the move to @livekit/react-native 3.1.0.',
                  '-keep class livekit.org.jni_zero.** { *; }',
                ].join('\n'),
              },
            },
          ],
          'expo-web-browser',
          // This app runs on its own Android UID and reaches the Commons/Accounts
          // providers over signature-protected IPC: this declares and requests
          // so.oxy.permission.IDENTITY and DEVICE_SESSION and adds the <queries>
          // for their providers. It also owns release signing: the release
          // buildType is signed with the Oxy ecosystem key from the OXY_UPLOAD_*
          // Gradle properties, and the build fails unless the result carries that
          // certificate (Commons serves the identity only to callers holding it).
          '@oxy.so/services/plugins/withOxySharedPermissions',
        ];

        // Only include expo-notifications for native builds (android/ios).
        // Insert at index 3 — AFTER the two splash entries (the
        // `oxySplashScreenPlugin` tuple at index 1 and the `@oxy.so/expo-splash`
        // branding plugin at index 2) so their load-bearing adjacency is preserved.
        if (PLATFORM !== 'web') {
          base.splice(3, 0, [
            'expo-notifications',
            {
              color: '#ffffff',
            },
          ]);
          // Add expo-contacts plugin for native platforms only
          base.push([
            'expo-contacts',
            {
              contactsPermission: 'Allow $(PRODUCT_NAME) to access your contacts.',
            },
          ]);
          // Google Cast is native-only (web cast loads the CAF sender SDK
          // via app/+html.tsx); the config plugin enables `expo prebuild`.
          base.push([
            'react-native-google-cast',
            {
              receiverAppId: 'CC1AD845', // Google default media receiver (HLS-capable)
              // The plugin defaults to '+' (latest). Cast framework 23.0.0 is
              // compiled with Kotlin 2.4 metadata, which RN 0.88's Kotlin 2.2
              // cannot read: the Android release build failed in
              // :app:compileReleaseKotlin. Pin the newest 22.x.
              androidPlayServicesCastFrameworkVersion: '22.3.1',
              iosLocalNetworkUsageDescription:
                'Syra usa la red local para encontrar dispositivos Cast y altavoces cercanos.',
            },
          ]);
        }

        return base;
      })(),
      extra: {
        eas: {
          projectId: '47bac898-ae20-479b-ab0f-2d8ab2770c83',
        },
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  };
};
