import type { ConfigPlugin } from 'expo/config-plugins';

/**
 * Types for `app.plugin.js`.
 *
 * The plugin itself has to stay JavaScript — Expo `require`s it from Node during
 * prebuild, with no TypeScript in the loop — but the app's tsconfig `include`
 * only covers `**​/*.ts(x)`, so importing it from a test fails typecheck with
 * TS6307. Declaring it here puts a `.ts` file in the project that describes the
 * `.js` one, which keeps the import plain and typed rather than a `require` cast.
 */

export interface SyraWidgetsPluginOptions {
  /** Bare origin of the API the widget fetches live rooms from. */
  apiBaseUrl?: string;
  /** Bare origin the widget's tap targets open. */
  webBaseUrl?: string;
}

/**
 * Throws when `value` is not a bare `http(s)` origin. Exported for tests and for
 * the plugin's own use; a bad origin has to fail the build rather than ship.
 */
export declare function assertBaseUrl(option: string, value: unknown): void;

declare const withSyraWidgets: ConfigPlugin<SyraWidgetsPluginOptions | void>;
export default withSyraWidgets;
