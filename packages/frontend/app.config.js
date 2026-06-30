const pkg = require('./package.json')
const fs = require('fs')
const path = require('path')

// FCM config lives at the monorepo root and is only present in CI / release
// setups (or via the GOOGLE_SERVICES_JSON env, as in Mention). Local dev-client
// builds don't have it — include it only when it actually exists so
// `expo prebuild` doesn't fail on a missing file.
const googleServicesJson = process.env.GOOGLE_SERVICES_JSON || path.resolve(__dirname, '../../google-services.json')
const hasGoogleServices = fs.existsSync(googleServicesJson)

module.exports = function(_config) {
    
    /**
     * App version number. Should be incremented as part of a release cycle.
     */
  const VERSION = pkg.version

  /**
   * Uses built-in Expo env vars
   *
   * @see https://docs.expo.dev/build-reference/variables/#built-in-environment-variables
   */
  const PLATFORM = process.env.EAS_BUILD_PLATFORM

  const IS_TESTFLIGHT = process.env.EXPO_PUBLIC_ENV === 'testflight'
  const IS_PRODUCTION = process.env.EXPO_PUBLIC_ENV === 'production'
  const IS_DEV = !IS_TESTFLIGHT && !IS_PRODUCTION


return {
    expo: {
        name: "Syra",
        slug: "syra",
        version: VERSION,
      orientation: 'portrait',
      icon: './assets/images/app-icon.png',
      scheme: 'syra',
      userInterfaceStyle: 'automatic',
      experiments: {
        typedRoutes: true,
        reactCompiler: true
      },
      ios: {
        supportsTablet: true,
        bundleIdentifier: 'com.syra.ios',
      },
        android: {
            adaptiveIcon: {
                foregroundImage: "./assets/images/app-icon_foreground.png",
                backgroundImage: "./assets/images/app-icon_background.png",
                monochromeImage: "./assets/images/app-icon_monochrome.png"
            },
            permissions: [
                "android.permission.CAMERA",
                "android.permission.RECORD_AUDIO"
            ],
            // Must match google-services.json package_name
            package: "com.syra.app",
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
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost:3001',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: '192.168.86.44:3001',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: '192.168.86.44:3000',
                            },
                            {
                                scheme: 'https',
                                host: 'oxy.so',
                            },
                            IS_DEV && {
                                scheme: 'http',
                                host: 'localhost:3000',
                            },
                        ],
                        category: ['BROWSABLE', 'DEFAULT'],
                    },
            ],
            softwareKeyboardLayoutMode: "pan",
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./assets/images/favicon.png",
            manifest: "./public/manifest.json",
            meta: {
                viewport: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
                themeColor: "#72184D",
                appleMobileWebAppCapable: "yes",
                appleMobileWebAppStatusBarStyle: "default",
                appleMobileWebAppTitle: "Syra",
                applicationName: "Syra",
                msapplicationTileColor: "#72184D",
                msapplicationConfig: "/browserconfig.xml"
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
                "expo-router",
                [
                    "expo-splash-screen",
                    {
                        image: "./assets/images/splash-icon.png",
                        imageWidth: 200,
                        resizeMode: "contain",
                        backgroundColor: "#ffffff"
                    }
                ],
                [
                    "expo-camera",
                    {
                        cameraPermission: "Allow $(PRODUCT_NAME) to access your camera",
                        microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone",
                        recordAudioAndroid: true
                    }
                ],
                "expo-image",
                "expo-image-picker",
                "expo-video",
                "expo-audio",
                [
                    "expo-secure-store",
                    {
                        configureAndroidBackup: true,
                        faceIDPermission: "Allow $(PRODUCT_NAME) to access your Face ID biometric data."
                    }
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
                    }
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
                        useLegacyPackaging: false
                      },
                    },
                ],
                "expo-web-browser",
            ];

            // Only include expo-notifications for native builds (android/ios)
            if (PLATFORM !== 'web') {
                base.splice(2, 0, [
                    "expo-notifications",
                    {
                        color: "#ffffff"
                    }
                ]);
                // Add expo-contacts plugin for native platforms only
                base.push([
                    "expo-contacts",
                    {
                        contactsPermission: "Allow $(PRODUCT_NAME) to access your contacts."
                    }
                ]);
                // Google Cast is native-only (web cast loads the CAF sender SDK
                // via app/+html.tsx); the config plugin enables `expo prebuild`.
                base.push([
                    'react-native-google-cast',
                    {
                        receiverAppId: 'CC1AD845', // Google default media receiver (HLS-capable)
                        iosLocalNetworkUsageDescription: 'Syra usa la red local para encontrar dispositivos Cast y altavoces cercanos.',
                    },
                ]);
            }

            return base;
        })(),
        extra: {
            eas: {
                projectId: "47bac898-ae20-479b-ab0f-2d8ab2770c83"
            },
            router: {
                origin: false
            }
        },
        owner: "oxyhq"
    }
};
};
