/**
 * Splitting an artist credit string into a principal artist and its features.
 *
 * A single `TPE1`/`ARTIST` string is the only artist information most files
 * carry, and it routinely bundles several people: `Nadia Ortiz feat. Kofi Mensah
 * & Ana Gil`. Grouping and resolution need the principal name; the rest belong in
 * `credits[]` as featured performers.
 *
 * DELIBERATE NARROWING of the plan's separator list. The plan says to split on
 * `feat.` / `ft.` / `&` / `,` / `vs.`. Splitting on a bare `&` or `,` anywhere in
 * the string destroys legitimate single names — `Earth, Wind & Fire` becomes
 * `Earth` with two invented featured artists, and `Emerson, Lake & Palmer`,
 * `Crosby, Stills & Nash` and every `… & The …` band go the same way. So `&`,
 * `,`, `;`, `/` and `x` separate names only WITHIN the featured remainder, after
 * an explicit feature marker has already established that the string is a
 * multi-artist credit. With no feature marker present the string is kept whole.
 *
 * Nothing is lost by being conservative here: a properly tagged multi-artist file
 * carries its artists as separate NUL-separated values (surfaced as
 * `ExtractedMetadata.artists`), and the resolution chain only ever LINKS an
 * artist id on a high-confidence signal — a plain name is medium confidence,
 * displayed as text and never written as an id. An over-eager split would
 * therefore not create a wrong link, but it would publish wrong credits, which
 * is a visible, permanent lie about who played on a record.
 */

/**
 * Markers that introduce featured performers mid-credit. Matched
 * case-insensitively and only after whitespace or an OPENING BRACKET, so
 * `Ftour Collective` and `Withered Hand` are still not mistaken for markers.
 *
 * The bracket half is not a nicety. `(feat. X)`, `(with X)` and `[feat. X]` are
 * how every major platform writes a feature, and requiring whitespace before the
 * marker meant the bracketed spelling — the common one — was never split:
 * `Joven y Salvaje (with Bb trickz)` came back whole, so its name key never
 * matched the registry's `Joven y Salvaje` and a correct upload was refused with
 * "belongs to a different recording". Measured on a real rejected file.
 *
 * The closing bracket is stripped by `splitFeatured`, which already trims and
 * drops empties, so `Bb trickz)` yields `Bb trickz`.
 */
const FEATURE_MARKER = /[\s([](?:feat\.?|ft\.?|featuring|with|vs\.?|versus|w\/)\s+/i;

/**
 * Markers that may open a credit — `feat. Kofi Mensah`, with no primary artist
 * before them.
 *
 * A NARROWER set than the mid-credit one on purpose. `feat.`/`ft.`/`featuring`
 * cannot begin an artist's name, so at the start of a string they are certainly
 * a marker. `with` and `vs.` can and do (`With Confidence`, `Vs Self`), and
 * treating those as markers would strip a real band's name to nothing.
 */
const LEADING_FEATURE_MARKER = /^(?:feat\.?|ft\.?|featuring)\s+/i;

/** Separators between names, applied only inside the featured remainder. */
const FEATURED_SEPARATOR = /\s*(?:,|&|;|\/|\sx\s|\svs\.?\s)\s*/i;

export interface ArtistCredit {
  /** The principal artist, or an empty string when the input has no name. */
  primary: string;
  /** Featured performers, in the order the credit lists them. */
  featured: string[];
}

/**
 * Split a raw artist credit.
 *
 * Returns `{ primary: '', featured: [] }` for an empty or whitespace-only input —
 * the "file names no artist at all" case, which callers must handle rather than
 * paper over.
 */
export function splitArtistCredit(raw: string): ArtistCredit {
  const value = raw.trim();
  if (!value) return { primary: '', featured: [] };

  const splitFeatured = (remainder: string): string[] =>
    remainder
      .split(FEATURED_SEPARATOR)
      // A bracketed feature carries its closing bracket into the remainder
      // (`Bb trickz)`), and a trailing `)`/`]` is never part of a name.
      .map((name) => name.trim().replace(/[)\]]+$/, '').trim())
      .filter((name) => name.length > 0);

  // A credit that is nothing but a feature (`feat. Kofi Mensah`) has no
  // principal artist; promoting the guest would attribute the track to them.
  const leading = LEADING_FEATURE_MARKER.exec(value);
  if (leading) {
    return { primary: '', featured: splitFeatured(value.slice(leading[0].length)) };
  }

  const markerMatch = FEATURE_MARKER.exec(value);
  if (!markerMatch) {
    return { primary: value, featured: [] };
  }

  return {
    primary: value.slice(0, markerMatch.index).trim(),
    featured: splitFeatured(value.slice(markerMatch.index + markerMatch[0].length)),
  };
}
