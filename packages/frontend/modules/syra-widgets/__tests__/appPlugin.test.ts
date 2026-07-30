import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolves through `app.plugin.d.ts` — see the note there for why the plugin
// itself stays JavaScript.
import { assertBaseUrl } from '../app.plugin';

/**
 * The widget's origins are baked into the APK as string resources, so a bad one
 * is not a runtime error a user reports — it is a widget that silently asks the
 * wrong host forever. These are the cases where that would happen.
 */
describe('withSyraWidgets: assertBaseUrl', () => {
  it('accepts a bare origin', () => {
    expect(() => assertBaseUrl('apiBaseUrl', 'https://api.syra.fm')).not.toThrow();
    expect(() => assertBaseUrl('apiBaseUrl', 'http://localhost:3000')).not.toThrow();
  });

  it('accepts a trailing slash, which is the same origin', () => {
    // Deliberately allowed rather than rejected: it denotes no path, and the
    // Kotlin side trims it (`RoomsApi`, `RoomsPresentation`). Failing a build
    // over a character that changes no request would be a lint, not a guard.
    expect(() => assertBaseUrl('apiBaseUrl', 'https://api.syra.fm/')).not.toThrow();
  });

  it('rejects a URL carrying a path, query or fragment', () => {
    // These would be concatenated into every request the widget makes.
    for (const value of [
      'https://api.syra.fm/api',
      'https://api.syra.fm?v=1',
      'https://api.syra.fm#x',
    ]) {
      expect(() => assertBaseUrl('apiBaseUrl', value)).toThrow(/bare origin/);
    }
  });

  it('rejects a non-absolute or non-http URL', () => {
    expect(() => assertBaseUrl('apiBaseUrl', 'api.syra.fm')).toThrow(/absolute URL/);
    expect(() => assertBaseUrl('apiBaseUrl', 'ftp://api.syra.fm')).toThrow(/http or https/);
  });

  it('rejects an empty or padded string', () => {
    expect(() => assertBaseUrl('apiBaseUrl', '')).toThrow(/non-empty string/);
    expect(() => assertBaseUrl('apiBaseUrl', ' https://api.syra.fm ')).toThrow(/non-empty string/);
  });

  it('names the option that was wrong', () => {
    // With two origins configurable, an error that does not say which one is
    // the same amount of work to debug as no error at all.
    expect(() => assertBaseUrl('webBaseUrl', 'nope')).toThrow(/webBaseUrl/);
  });

  it('accepts the production defaults the module actually ships', () => {
    // The validator and the shipped defaults are two halves of one contract and
    // nothing else compares them: an early version of `config.xml` carried
    // `https://api.syra.fm/api`, which this validator rejects, so a dev build
    // could never have expressed the production shape. Both sides passed their
    // own tests; only reading the real resource file catches the disagreement.
    const configXml = readFileSync(
      join(__dirname, '..', 'android', 'src', 'main', 'res', 'values', 'config.xml'),
      'utf8',
    );

    const shipped = [...configXml.matchAll(/<string name="(syra_widget_\w+)"[^>]*>([^<]+)<\/string>/g)];

    // Vacuity floor: a regex that stopped matching would otherwise pass by
    // asserting nothing at all.
    expect(shipped.map(([, name]) => name).sort()).toEqual([
      'syra_widget_api_base_url',
      'syra_widget_web_base_url',
    ]);

    for (const [, name, value] of shipped) {
      expect(() => assertBaseUrl(name, value)).not.toThrow();
    }
  });
});
