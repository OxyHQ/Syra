/**
 * ISRC → artist MBID, the one link missing from the licensed-image chain.
 *
 * Everything needed to put a photograph on a contributed artist's profile is
 * already built: `findWikidataItemByArtistMbid` locates the Wikidata item,
 * `lookupArtistOnWikidata` reads `P18` and the biographical facts, and
 * `fetchCommonsImage` fetches the file with its licence and attribution. All
 * three hang off a MusicBrainz artist id — and nothing produced one. The id
 * arrived only when a file's own tags carried `MUSICBRAINZ_ARTISTID`, which a
 * stream ripper never writes, so for the entire contributed population the chain
 * was built and never fired.
 *
 * The local MusicBrainz slice cannot answer it either: `IsrcRegistry` stores
 * `recordingMbid` and `artistCredit` — a NAME — and no artist id. Resolving a
 * name back to an id is the ambiguous matching this whole design exists to
 * avoid.
 *
 * So this asks MusicBrainz directly, and asks the only question with an
 * unambiguous answer: which artist is credited on the recording this code names.
 */

import { asArray, asRecord, fetchEnrichmentJson } from './enrichmentHttp';
import { ISRC_PATTERN, normalizeIsrc } from '@syra/shared-types';
import { logger } from '../../utils/logger';

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/**
 * The artist MusicBrainz credits on the recording this ISRC names.
 *
 * Returns a value only when every recording under the code agrees on ONE artist.
 * A code can name several recordings — an original and its remaster share one
 * frequently — and where those disagree about who made them, picking the first
 * is how the wrong face reaches a profile. That is the failure this returns
 * `undefined` for, and `undefined` here costs a photograph while a wrong answer
 * costs an artist their identity on a page they did not make.
 *
 * The first credited artist of a collaboration is taken deliberately: it is the
 * same "primary artist" rule `splitArtistCredit` applies to a `feat.` string, so
 * a track and its profile agree about who the containing artist is.
 */
export async function findArtistMbidByIsrc(rawIsrc: string): Promise<string | undefined> {
  // Normalise then test, matching `resolveIsrc` — a code arrives in the
  // hyphenated form it is printed in as often as not.
  const isrc = normalizeIsrc(rawIsrc);
  if (!ISRC_PATTERN.test(isrc)) return undefined;

  const body = asRecord(
    await fetchEnrichmentJson(
      `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}` +
        '?fmt=json&inc=artist-credits',
    ),
  );

  const recordings = asArray(body?.recordings);

  const credited = new Set<string>();
  for (const entry of recordings) {
    const credits = asRecord(entry)?.['artist-credit'];
    const first = asRecord(asArray(credits)[0]);
    const id = asRecord(first?.artist)?.id;
    if (typeof id === 'string' && MBID_PATTERN.test(id)) credited.add(id.toLowerCase());
  }

  if (credited.size !== 1) {
    if (credited.size > 1) {
      logger.info('[musicbrainz] an ISRC names recordings by different artists; not linking', {
        isrc,
        artists: credited.size,
      });
    }
    return undefined;
  }
  return [...credited][0];
}
