/**
 * Wikidata — the bridge from a MusicBrainz artist id to a photograph and a
 * biography we are actually allowed to publish.
 *
 * Wikidata's own content is CC0 with no commercial restriction, which is why it
 * is queried LIVE while MusicBrainz is not (MetaBrainz charges for commercial
 * use of the web service, so that side comes from the CC0 dump instead).
 *
 * The route in is `P434`, Wikidata's MusicBrainz-artist-id property. That
 * matters more than it looks: it means the join is on a stable identifier the
 * artist's own MusicBrainz entry declares, NOT on a name. A name-based lookup
 * would confidently return the wrong "Nirvana", the wrong "Eclipse", the wrong
 * "Prince" — and a profile carrying a stranger's face is worse than an empty
 * one, because it looks finished.
 *
 * Everything here is read-only and best-effort: an absent property yields an
 * absent field, never a guess.
 */

import {
  asArray,
  asRecord,
  asString,
  fetchEnrichmentJson,
} from './enrichmentHttp';

// ── Wikidata property ids ───────────────────────────────────────────────────

/**
 * The properties read, named so the call sites are legible.
 *
 * These are Wikidata's stable identifiers, not our own vocabulary — `P18` is
 * "image" for every item on Wikidata and will not be renumbered.
 */
const PROPERTY = {
  image: 'P18',
  countryOfCitizenship: 'P27',
  countryOfOrigin: 'P495',
  inception: 'P571',
  dissolved: 'P576',
  dateOfBirth: 'P569',
  dateOfDeath: 'P570',
  hasPart: 'P527',
  memberOf: 'P463',
  recordLabel: 'P264',
  officialWebsite: 'P856',
  musicBrainzArtistId: 'P434',
  discogsArtistId: 'P1953',
  isni: 'P213',
  ipi: 'P1828',
  instagram: 'P2003',
  youtubeChannel: 'P2397',
  soundcloud: 'P3040',
  bandcamp: 'P3283',
  x: 'P2002',
} as const;

// ── Result shape ────────────────────────────────────────────────────────────

/** A named entity referenced by a claim — a band member, a record label. */
export interface WikidataNamedItem {
  /** The Wikidata item id, e.g. `Q1203`. */
  id: string;
  /** The English label, once resolved. Absent when the item has none. */
  name?: string;
}

export interface WikidataArtistFacts {
  /** The Wikidata item id this came from, e.g. `Q1299`. */
  itemId: string;
  /** The English label — the artist's name as Wikidata states it. */
  name?: string;
  /** The one-line English description, e.g. "English pop rock band (1960–1970)". */
  description?: string;
  aliases: string[];
  /**
   * Commons FILE NAME of the primary photograph (`P18`), e.g.
   * `Beatles Trenter 1963.jpg`. Not a URL — resolving it to bytes AND to its
   * licence is `wikimediaCommons.ts`'s job, and the two must happen together.
   */
  imageFileName?: string;
  /** ISO-8601, possibly partial: Wikidata routinely states a bare year. */
  activeFrom?: string;
  activeUntil?: string;
  /** Wikidata item ids for the country, to be resolved to a label. */
  country?: WikidataNamedItem;
  members: WikidataNamedItem[];
  labels: WikidataNamedItem[];
  officialWebsite?: string;
  isni?: string;
  ipi?: string;
  discogsArtistId?: string;
  instagram?: string;
  x?: string;
  youtube?: string;
  soundcloud?: string;
  bandcamp?: string;
}

// ── Claim readers ───────────────────────────────────────────────────────────

type Claims = Record<string, unknown>;

function claimValues(claims: Claims, property: string): unknown[] {
  return asArray(claims[property])
    .map((claim) => asRecord(claim)?.mainsnak)
    .map((snak) => asRecord(snak))
    .filter((snak): snak is Record<string, unknown> => snak !== undefined)
    // A `novalue`/`somevalue` snak has no datavalue: Wikidata's way of saying
    // "known to be absent" or "known to exist but unknown". Both mean we have
    // nothing to write.
    .map((snak) => asRecord(snak.datavalue)?.value)
    .filter((value) => value !== undefined);
}

function firstStringClaim(claims: Claims, property: string): string | undefined {
  for (const value of claimValues(claims, property)) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

function itemIdClaims(claims: Claims, property: string): string[] {
  const ids: string[] = [];
  for (const value of claimValues(claims, property)) {
    const id = asString(asRecord(value)?.id);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Read a Wikidata time value as an ISO-8601 string, keeping its PRECISION.
 *
 * Wikidata states times as `+1960-00-00T00:00:00Z` with a separate `precision`
 * field: 9 is year, 10 is month, 11 is day. The zeroed components are not
 * "January 1st", they are "unknown" — so a bare year is returned as `1960`
 * rather than `1960-01-01`, which would invent a day the source never claimed
 * and would then render as a precise founding date on the profile.
 */
function timeClaim(claims: Claims, property: string): string | undefined {
  for (const value of claimValues(claims, property)) {
    const record = asRecord(value);
    const time = asString(record?.time);
    if (!time) continue;
    const precision = typeof record?.precision === 'number' ? record.precision : 11;

    // Leading sign, then YYYY-MM-DD. Negative years (BCE) are not something a
    // recording artist has, and an ISO string cannot carry them anyway.
    const match = /^\+(\d{4,})-(\d{2})-(\d{2})T/.exec(time);
    if (!match) continue;
    const [, year, month, day] = match;
    if (precision <= 9) return year;
    if (precision === 10) return `${year}-${month}`;
    return `${year}-${month}-${day}`;
  }
  return undefined;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find the Wikidata item for a MusicBrainz artist id.
 *
 * Uses CirrusSearch's `haswbstatement` keyword rather than SPARQL: it is a
 * single cheap API call against an index built for exactly this, where the
 * SPARQL endpoint is heavily rate-limited and periodically refuses queries under
 * load. Verified against `b10bbbfc-…` (The Beatles) → `Q1299`, one hit.
 *
 * Returns `undefined` when the search returns anything other than exactly one
 * hit. Two items claiming the same MBID means Wikidata has a duplicate, and
 * picking one at random is how the wrong face reaches a profile.
 */
export async function findWikidataItemByArtistMbid(mbid: string): Promise<string | undefined> {
  if (!MBID_PATTERN.test(mbid)) return undefined;

  const url =
    'https://www.wikidata.org/w/api.php?action=query&list=search&format=json&srlimit=2' +
    `&srsearch=${encodeURIComponent(`haswbstatement:${PROPERTY.musicBrainzArtistId}=${mbid}`)}`;

  const body = asRecord(await fetchEnrichmentJson(url));
  const hits = asArray(asRecord(body?.query)?.search);
  if (hits.length !== 1) return undefined;

  const title = asString(asRecord(hits[0])?.title);
  return title !== undefined && /^Q\d+$/.test(title) ? title : undefined;
}

/**
 * Resolve Wikidata item ids to their English labels, in one batched call.
 *
 * `wbgetentities` takes up to 50 ids at a time. Items with no English label come
 * back with an empty `labels` object and are returned with `name` absent rather
 * than with their raw `Q…` id — a profile listing "Q1203" as a band member is
 * worse than one listing nothing.
 */
export async function resolveWikidataLabels(
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(ids)].filter((id) => /^Q\d+$/.test(id));

  for (let start = 0; start < unique.length; start += 50) {
    const batch = unique.slice(start, start + 50);
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en' +
      `&ids=${encodeURIComponent(batch.join('|'))}`;

    const entities = asRecord(asRecord(await fetchEnrichmentJson(url))?.entities);
    if (!entities) continue;
    for (const [id, entity] of Object.entries(entities)) {
      const label = asString(asRecord(asRecord(asRecord(entity)?.labels)?.en)?.value);
      if (label) resolved.set(id, label);
    }
  }
  return resolved;
}

/**
 * Fetch and read a Wikidata item into the facts enrichment can use.
 *
 * `Special:EntityData/<id>.json` is the canonical, cacheable entity document —
 * the same one Wikidata serves to its own tools.
 */
export async function fetchWikidataArtistFacts(
  itemId: string,
): Promise<WikidataArtistFacts | undefined> {
  if (!/^Q\d+$/.test(itemId)) return undefined;

  const body = asRecord(
    await fetchEnrichmentJson(`https://www.wikidata.org/wiki/Special:EntityData/${itemId}.json`),
  );
  const entity = asRecord(asRecord(body?.entities)?.[itemId]);
  if (!entity) return undefined;

  const claims = asRecord(entity.claims) ?? {};
  const labels = asRecord(entity.labels);
  const descriptions = asRecord(entity.descriptions);
  const aliasGroups = asRecord(entity.aliases);

  const memberIds = itemIdClaims(claims, PROPERTY.hasPart);
  const labelIds = itemIdClaims(claims, PROPERTY.recordLabel);
  // Country of origin is the band-shaped property; citizenship the person-shaped
  // one. Reading both means one code path covers a group and a solo artist.
  const countryId =
    itemIdClaims(claims, PROPERTY.countryOfOrigin)[0] ??
    itemIdClaims(claims, PROPERTY.countryOfCitizenship)[0];

  const named = await resolveWikidataLabels([...memberIds, ...labelIds, ...(countryId ? [countryId] : [])]);
  const toNamedItem = (id: string): WikidataNamedItem => {
    const name = named.get(id);
    return name === undefined ? { id } : { id, name };
  };

  return {
    itemId,
    name: asString(asRecord(labels?.en)?.value),
    description: asString(asRecord(descriptions?.en)?.value),
    aliases: asArray(aliasGroups?.en)
      .map((alias) => asString(asRecord(alias)?.value))
      .filter((alias): alias is string => alias !== undefined),

    imageFileName: firstStringClaim(claims, PROPERTY.image),

    // A group has an inception and a dissolution; a person has a birth and a
    // death. "Years active" means the first pair for one and the second for the
    // other, so both are read and the group-shaped one wins when both exist.
    activeFrom: timeClaim(claims, PROPERTY.inception) ?? timeClaim(claims, PROPERTY.dateOfBirth),
    activeUntil: timeClaim(claims, PROPERTY.dissolved) ?? timeClaim(claims, PROPERTY.dateOfDeath),

    country: countryId === undefined ? undefined : toNamedItem(countryId),
    members: memberIds.map(toNamedItem),
    labels: labelIds.map(toNamedItem),

    officialWebsite: firstStringClaim(claims, PROPERTY.officialWebsite),
    isni: firstStringClaim(claims, PROPERTY.isni),
    ipi: firstStringClaim(claims, PROPERTY.ipi),
    discogsArtistId: firstStringClaim(claims, PROPERTY.discogsArtistId),
    instagram: firstStringClaim(claims, PROPERTY.instagram),
    x: firstStringClaim(claims, PROPERTY.x),
    youtube: firstStringClaim(claims, PROPERTY.youtubeChannel),
    soundcloud: firstStringClaim(claims, PROPERTY.soundcloud),
    bandcamp: firstStringClaim(claims, PROPERTY.bandcamp),
  };
}

/**
 * The whole Wikidata leg: MusicBrainz artist id in, facts out.
 *
 * Takes the MBID rather than a name, and there is no name-based overload, so a
 * caller cannot reach this with a low-confidence match even by mistake.
 */
export async function lookupArtistOnWikidata(
  musicbrainzArtistId: string,
): Promise<WikidataArtistFacts | undefined> {
  const itemId = await findWikidataItemByArtistMbid(musicbrainzArtistId);
  if (!itemId) return undefined;
  return fetchWikidataArtistFacts(itemId);
}
