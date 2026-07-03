const pkg = require('./package.json')

module.exports = function (_config) {
  /**
   * App version number. Should be incremented as part of a release cycle.
   */
  const VERSION = pkg.version

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
          viewport:
            'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
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
        'expo-router',
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
            faceIDPermission:
              'Allow $(PRODUCT_NAME) to access your Face ID biometric data.',
          },
        ],
        [
          'expo-build-properties',
          {
            ios: {
              deploymentTarget: '16.4',
            },
            android: {
              compileSdkVersion: 36,
              targetSdkVersion: 36,
              buildToolsVersion: '36.0.0',
              enableProguardInReleaseBuilds: true,
              enableShrinkResourcesInReleaseBuilds: true,
              useLegacyPackaging: false,
            },
          },
        ],
        'expo-web-browser',
      ],
      extra: {
        router: {
          origin: false,
        },
      },
      owner: 'oxyhq',
    },
  }
}
