const pkg = require('./package.json');

// Syra's registered Oxy client id (public), resolved exactly as `config.ts` resolves
// the one OxyProvider uses. Release builds and OTA exports take it from eas.json's
// production env. Studio is a surface of the Syra application, like the listener
// app, so its OTA updates use their own channel.
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_3b5d68c224b7eaf690b2f682fb60399b31e5c7ab87c66181';
const OXY_UPDATES_CHANNEL = 'studio-production';

// App variant: a development build sits next to the production app on the same
// device with its own applicationId/bundleId and name. Build it with
// `APP_VARIANT=development`; production is the default. Commons' and
// @oxy.so/services' caller allow-lists hold both ids.
const IS_DEV_VARIANT = process.env.APP_VARIANT === 'development';
const APP_ID = IS_DEV_VARIANT ? 'fm.syra.studio.dev' : 'fm.syra.studio';
const APP_NAME = IS_DEV_VARIANT ? 'Syra Studio (Dev)' : 'Syra Studio';

module.exports = function (_config) {
  /**
   * App version number. Should be incremented as part of a release cycle.
   */
  const VERSION = pkg.version;

  return {
    expo: {
      name: APP_NAME,
      slug: 'syra-studio',
      version: VERSION,
      orientation: 'portrait',
      icon: './assets/images/icon.png',
      scheme: 'syrastudio',
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
        bundleIdentifier: APP_ID,
      },
      android: {
        adaptiveIcon: {
          foregroundImage: './assets/images/app-icon_foreground.png',
          backgroundImage: './assets/images/app-icon_background.png',
        },
        package: APP_ID,
        // App Links: studio.syra.fm serves /.well-known/assetlinks.json for
        // fm.syra.studio (public/.well-known/assetlinks.json, deployed with the web app).
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                host: 'studio.syra.fm',
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
        meta: {
          viewport: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
          themeColor: '#72184D',
          appleMobileWebAppCapable: 'yes',
          appleMobileWebAppStatusBarStyle: 'default',
          appleMobileWebAppTitle: 'Syra Studio',
          applicationName: 'Syra Studio',
        },
        build: {
          babel: {
            include: ['@expo/vector-icons'],
          },
        },
        // Metro configuration is handled in metro.config.js
      },
      plugins: [
        // SDK 58 turns on async routes for web by default; keep SDK 57's single
        // web bundle (the bundle budget is measured against that shape).
        ['expo-router', { asyncRoutes: { web: false } }],
        [
          'expo-splash-screen',
          {
            image: './assets/images/icon.png',
            imageWidth: 200,
            resizeMode: 'contain',
            backgroundColor: '#ffffff',
          },
        ],
        'expo-image',
        'expo-image-picker',
        [
          'expo-secure-store',
          {
            configureAndroidBackup: true,
            faceIDPermission: 'Allow $(PRODUCT_NAME) to access your Face ID biometric data.',
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
        // for their providers.
        '@oxy.so/services/plugins/withOxySharedPermissions',
        // OTA updates from Oxy Updates (`.github/workflows/publish-update.yml`
        // publishes every push to main). It also derives android.versionCode and
        // ios.buildNumber from `version`, which is the OTA boundary: bump it for a
        // native change and the next push to main releases a new binary.
        [
          '@oxy.so/app-preset/plugin/withOxyUpdates',
          { clientId: OXY_CLIENT_ID, channel: OXY_UPDATES_CHANNEL },
        ],
      ],
      extra: {
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  };
};
