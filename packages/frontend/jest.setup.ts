// Resolve Expo's lazy fetch while the native-module mocks are alive. Jest
// inspects enumerable globals during teardown, after its module registry is gone.
import 'expo/src/winter/runtime.native';
void globalThis.fetch;
