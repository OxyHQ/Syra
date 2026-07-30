const { withStringsXml, AndroidConfig } = require('expo/config-plugins');

/**
 * Repoint the widget's origins for a dev or staging build.
 *
 * The widget cannot read `config.ts`: it runs in the launcher's process, outside
 * the JS runtime, so its origins have to be Android string resources baked at
 * build time. The module ships production defaults in `res/values/config.xml`;
 * writing the same names into the APP module's `strings.xml` overrides them at
 * manifest-merge time, which is what this plugin does.
 */

const API_BASE_URL_RESOURCE = 'syra_widget_api_base_url';
const WEB_BASE_URL_RESOURCE = 'syra_widget_web_base_url';

/**
 * Reject anything that is not a bare `http(s)` origin.
 *
 * A path, query or fragment here would be silently concatenated into every
 * request the widget makes, so it fails the build rather than shipping a widget
 * that quietly asks the wrong URL.
 */
function assertBaseUrl(option, value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`withSyraWidgets: \`${option}\` must be a non-empty string with no surrounding whitespace.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`withSyraWidgets: \`${option}\` must be an absolute URL, got ${JSON.stringify(value)}.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`withSyraWidgets: \`${option}\` must be http or https, got ${parsed.protocol}.`);
  }

  const bareOrigin = value.replace(/\/+$/, '');
  if (bareOrigin !== parsed.origin) {
    throw new Error(
      `withSyraWidgets: \`${option}\` must be a bare origin with no path, query or fragment, got ${JSON.stringify(value)}.`,
    );
  }
}

module.exports = function withSyraWidgets(config, options = {}) {
  const overrides = [];

  if (options.apiBaseUrl !== undefined) {
    assertBaseUrl('apiBaseUrl', options.apiBaseUrl);
    overrides.push([API_BASE_URL_RESOURCE, options.apiBaseUrl]);
  }
  if (options.webBaseUrl !== undefined) {
    assertBaseUrl('webBaseUrl', options.webBaseUrl);
    overrides.push([WEB_BASE_URL_RESOURCE, options.webBaseUrl]);
  }

  if (overrides.length === 0) {
    return config;
  }

  return withStringsXml(config, (config) => {
    for (const [name, value] of overrides) {
      config.modResults = AndroidConfig.Strings.setStringItem(
        [AndroidConfig.Resources.buildResourceItem({ name, value, translatable: false })],
        config.modResults,
      );
    }
    return config;
  });
};

module.exports.assertBaseUrl = assertBaseUrl;
