const pkg = require('./package.json');

module.exports = function (_config) {
  /**
   * App version number. Should be incremented as part of a release cycle.
   */
  const VERSION = pkg.version;

  return {
    expo: {
      name: 'Syra Studio',
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
        bundleIdentifier: 'com.syra.studio',
      },
      android: {
        adaptiveIcon: {
          foregroundImage: './assets/images/app-icon_foreground.png',
          backgroundImage: './assets/images/app-icon_background.png',
        },
        package: 'com.syra.studio',
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                host: 'studio.syra.fm',
              },
              {
                scheme: 'https',
                host: 'oxy.so',
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
        // Release buildType bits expo-build-properties cannot express: the R8
        // -optimize proguard file, and the real release signing config
        // (credentials come from Gradle properties, never the repo). The artefact
        // MUST carry the shared Oxy ecosystem certificate: Commons serves the
        // identity only to callers holding the signature permissions below.
        '@oxy.so/app-preset/plugin/withOxyAndroidRelease',
        // This app runs on its own Android UID and reaches the Commons/Accounts
        // providers over signature-protected IPC: this declares and requests
        // so.oxy.permission.IDENTITY and DEVICE_SESSION and adds the <queries>
        // for their providers.
        '@oxy.so/services/plugins/withOxySharedPermissions',
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
