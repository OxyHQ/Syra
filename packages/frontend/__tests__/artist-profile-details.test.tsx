import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { EntityProfile } from '@syra/shared-types';
import { ArtistAbout } from '@/components/artist/ArtistAbout';
import { ArtistProfileHeading } from '@/components/artist/ArtistProfileHeading';
import en from '@/locales/en.json';
import es from '@/locales/es.json';

const i18n = createInstance();
const navigate = jest.fn();
const openLink = jest.fn();
let renderer: ReactTestRenderer | undefined;
beforeAll(async () => { await i18n.init({ lng: 'es', fallbackLng: 'en', resources: { en: { translation: en }, es: { translation: es } }, interpolation: { escapeValue: false } }); });
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; jest.clearAllMocks(); });
function render(element: React.ReactElement) {
  act(() => { renderer = create(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>); });
  if (!renderer) throw new Error('Renderer did not mount');
  return renderer;
}
const entity: EntityProfile = { id: 'band', kind: 'artist', name: 'Band' };
it.each([0, 1, 123456])('renders %s monthly listeners immediately after the heading with real Spanish plurals', (count) => {
  const stats = { followers: 99, tracks: 1, albums: 1, totalPlays: 1, monthlyListeners: count, monthlyListenersComputedAt: '2026-09-17T00:00:00Z' };
  const text = JSON.stringify(render(<ArtistProfileHeading name="Band" stats={stats} />).toJSON());
  const expected = `${new Intl.NumberFormat('es').format(count)} ${count === 1 ? 'oyente mensual' : 'oyentes mensuales'}`;
  expect(text).toContain(expected);
  expect(text.indexOf('Band')).toBeLessThan(text.indexOf(expected));
  expect(text).not.toContain('99');
});
it('does not invent an about section for an empty profile', () => {
  expect(render(<ArtistAbout entity={entity} hasImage={false} onNavigateArtist={navigate} onOpenLink={openLink} />).toJSON()).toBeNull();
});
it('renders full biography, partial dates, aliases, labels, and resolved and unresolved members', () => {
  const rich = { ...entity, bio: 'The full biography.', activeFrom: '1973', aliases: ['Another name'], labels: ['Independent'], members: [{ name: 'Linked member', nameKey: 'linked', catalogEntityId: 'member', from: '1980' }, { name: 'Text member', nameKey: 'text', until: '1999-06' }] };
  const tree = render(<ArtistAbout entity={rich} hasImage={false} onNavigateArtist={navigate} onOpenLink={openLink} />);
  const text = JSON.stringify(tree.toJSON());
  for (const value of ['The full biography.', '1973', 'Another name', 'Independent', '1999-06', 'Text member']) expect(text).toContain(value);
  expect(text).not.toContain('1973-01-01');
  const links = tree.root.findAll((node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function', { deep: false });
  expect(links).toHaveLength(1);
  act(() => links[0].props.onPress());
  expect(navigate).toHaveBeenCalledWith('member');
});
it('shows photo attribution and safe licence/source links only when the image is displayed', () => {
  const licensed = { ...entity, imageLicence: { attribution: 'Photographer', licence: 'CC BY-SA 4.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg' } };
  const tree = render(<ArtistAbout entity={licensed} hasImage onNavigateArtist={navigate} onOpenLink={openLink} />);
  expect(JSON.stringify(tree.toJSON())).toContain('Photographer');
  const links = tree.root.findAll((node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function', { deep: false });
  expect(links).toHaveLength(2);
  act(() => links[0].props.onPress());
  expect(openLink).toHaveBeenCalledWith(licensed.imageLicence.licenceUrl);
});
it('keeps attribution text but never makes script URLs clickable', () => {
  const tree = render(<ArtistAbout entity={{ ...entity, imageLicence: { attribution: 'Photographer', licence: 'Custom licence', licenceUrl: 'javascript:alert(1)', sourceUrl: 'data:text/html,unsafe' } }} hasImage onNavigateArtist={navigate} onOpenLink={openLink} />);
  expect(JSON.stringify(tree.toJSON())).toContain('Photographer');
  expect(tree.root.findAll((node) => node.props.accessibilityRole === 'link')).toHaveLength(0);
});
