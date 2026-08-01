/**
 * `nameKey` — the ONE normalisation used to decide whether two names are the
 * same name.
 *
 * Every identity in the catalog that is keyed by a human-written name goes
 * through this function: artist dedup (`CatalogEntity.nameKey`, unique among
 * artists), podcast person dedup, locker album grouping (`UserUpload.albumKey`),
 * credits, and the ISRC registry's `artistCreditNameKey`. A second
 * implementation that normalised even slightly differently would not fail — it
 * would silently split one identity into two, and the duplicate rows it created
 * could not be merged afterwards. So there is exactly one definition, here, and
 * everything imports it.
 *
 * The steps, in order:
 *  1. NFKD — decomposes accents into base + combining mark, and folds
 *     compatibility forms (full-width `Ｒａｍｏｎ`, ligatures, superscripts)
 *     onto their plain equivalents.
 *  2. Drop combining marks from LATIN base letters only, so `Ramón` and `Ramon`
 *     agree. See {@link LATIN_COMBINING_MARKS} for why other scripts are exempt.
 *  3. Lowercase.
 *  4. Punctuation and symbols become spaces, so `A.C.`, `A C` and `A-C` agree.
 *  5. Collapse whitespace and trim.
 *  6. NFC, so a mark that survived step 2 is stored in its normal precomposed
 *     form (`и` + breve is written back as `й`) rather than as a decomposition
 *     that looks identical and compares unequal to the obvious spelling.
 *
 * NOTE ON REGEXES: no Unicode property escapes (`\p{…}`/`\P{…}`) anywhere in
 * this file. Mobile Hermes rejects them at RUNTIME even though the desktop
 * compiler and every web engine accept them, and this module is bundled into the
 * apps through `@syra/shared-types`. Explicit ranges only.
 */

/**
 * A combining mark ATTACHED TO A LATIN LETTER — the only kind that is stripped.
 *
 * The capture is the base letter; the marks after it are dropped. `[A-Za-z]` is
 * the whole Latin test and it is sufficient rather than lazy: NFKD has already
 * run, and it decomposes every accented Latin letter, from Latin-1 `é` to Latin
 * Extended Additional `ḃ`, down to an ASCII base plus marks. A Latin letter that
 * does NOT decompose (`ø`, `đ`) carries no mark to strip in the first place.
 *
 * Other scripts keep their marks, and the reason is specific rather than
 * cautious. Folding Cyrillic marks does not solve the Cyrillic problem: the
 * inconsistent spelling people actually have in their tags is a TRANSLITERATION
 * ("Мумий Тролль" vs "Mumiy Troll"), a different script entirely, which no
 * amount of mark-stripping will ever merge. So the strip buys nothing there —
 * while costing a false merge of `й` into `и`, which are different letters in
 * Russian.
 *
 * That cost is not cosmetic, which is what makes the exception necessary rather
 * than merely tidy: artist `nameKey` carries a UNIQUE index, so a false merge
 * does not render two artists alike, it makes the second one IMPOSSIBLE TO
 * CREATE. "Мумии Тролль" would be permanently uncreatable because "Мумий
 * Тролль" exists. Latin is the opposite case — there the merge is usually the
 * answer you wanted, and it pays for itself.
 *
 * Do not "simplify" this back to an unconditional strip.
 */
const LATIN_COMBINING_MARKS = /([A-Za-z])[̀-ͯ]+/g;

/**
 * Punctuation and symbols, replaced by a space rather than deleted — deleting
 * would fuse `Simon & Garfunkel` into `simongarfunkel`, which then no longer
 * matches the same name written with the word "and".
 *
 * ASCII punctuation, plus General Punctuation (curly quotes, en/em dashes,
 * ellipsis) and CJK Symbols and Punctuation. Full-width ASCII needs no range of
 * its own: NFKD has already folded it down to plain ASCII by this point.
 */
const PUNCTUATION = /[!-\/:-@\[-`{-~ -⁯　-〿]/g;

const WHITESPACE_RUN = /\s+/g;

/**
 * Normalise a human-written name into its matching key.
 *
 * Idempotent: `normalizeNameKey(normalizeNameKey(x)) === normalizeNameKey(x)`,
 * so it is safe to call on a value that may already be a key.
 */
export function normalizeNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(LATIN_COMBINING_MARKS, '$1')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .normalize('NFC');
}

/**
 * Names that must NEVER become a `CatalogEntity`.
 *
 * These are placeholders a tagger writes when it has nothing — not artists.
 * Letting one through creates a permanent catalog row called "Unknown Artist"
 * that every untagged upload then attaches itself to, and there is no way back:
 * the recordings underneath it have no real attribution to restore, so nobody
 * can ever split them apart again. This is the single path by which a catalog
 * fills with irreversible garbage.
 *
 * Stored already normalised, so the comparison is an exact match on the key.
 * `[unknown]`, `V.A.` and `V/A` are absent because they normalise into entries
 * that ARE here (`unknown`, `v a`) — the list is keys, not spellings.
 */
export const DENYLISTED_ARTIST_NAME_KEYS: readonly string[] = [
  '',
  'unknown',
  'unknown artist',
  'unknown artists',
  'various',
  'various artists',
  'varios artistas',
  'artista desconocido',
  'artistas desconocidos',
  'desconocido',
  'sin artista',
  'va',
  'v a',
  'none',
  'n a',
  'null',
  'undefined',
];

const DENYLISTED_ARTIST_NAME_KEY_SET = new Set(DENYLISTED_ARTIST_NAME_KEYS);

/**
 * Is this a placeholder rather than an artist?
 *
 * Accepts either a raw name or an already-normalised key — it normalises what it
 * is given, because a caller that forgot to normalise first would otherwise get
 * a silent `false` for `"Various Artists"` and create the row this list exists
 * to prevent.
 */
export function isDenylistedArtistName(value: string): boolean {
  return DENYLISTED_ARTIST_NAME_KEY_SET.has(normalizeNameKey(value));
}

/**
 * How much of each component survives into an {@link buildAlbumKey} key.
 *
 * A tag field is arbitrary user-supplied text and some files carry absurd ones.
 * MongoDB refuses an index key over 1024 bytes, so an untruncated composite key
 * would not merely be ugly — it would make the insert FAIL, on exactly the
 * pathological file nobody tests with. Truncating only ever merges two albums
 * whose first 120 normalised characters are identical, which is a merge you
 * would want anyway.
 */
const ALBUM_KEY_COMPONENT_MAX = 120;

/**
 * The stable grouping key for an album, in the catalog and in a private locker.
 *
 * `(album artist, album title, year)` normalised and joined. Two files belong to
 * the same album exactly when this matches — that is how a multi-file upload
 * groups into ONE album instead of one album per file, and how locker album
 * pages are derived by aggregation without a per-user Album collection existing
 * at all.
 *
 * A readable composite rather than a digest, deliberately: it can be eyeballed
 * in a document or a log to see WHY two files did or did not group, it cannot
 * collide the way a truncated hash can, and it needs no crypto — so the one
 * definition works unchanged in the backend and in an app bundle.
 *
 * The year is part of the key because reissues are genuinely different releases;
 * an absent year is its own bucket rather than a wildcard, since guessing that
 * an untagged file belongs to a dated release is how unrelated albums merge.
 */
export function buildAlbumKey(input: {
  albumArtistName?: string;
  albumName?: string;
  year?: number;
}): string {
  const artist = normalizeNameKey(input.albumArtistName ?? '').slice(0, ALBUM_KEY_COMPONENT_MAX);
  const album = normalizeNameKey(input.albumName ?? '').slice(0, ALBUM_KEY_COMPONENT_MAX);
  const year = Number.isFinite(input.year) ? String(input.year) : '';
  return `${artist}|${album}|${year}`;
}
