// Native/web-app entrypoint. The package `exports` map routes the `react-native`
// and `browser` conditions HERE, so Expo/RN consumers get the live-rooms engine on
// top of the base SDK. Plain Node resolution (`import`/`require`/`default`) lands on
// `./index`, which deliberately omits `./live` — the engine needs react-native peers
// that cannot load off-device. Exposure of live is therefore a property of the
// CONSUMER's resolution conditions, not of `@syra.fm/sdk`.
export * from './index';
export * from './live';
