/**
 * Wikimedia Commons — resolving a file name to an image we may legally display.
 *
 * The licence is the point of this module, not a field it happens to carry.
 * Commons images are individually licensed: some are CC0, some public domain,
 * many are CC BY-SA, which is satisfied only by naming the author and linking
 * both the work and its licence. Rehosting one without that is a licence breach.
 *
 * So {@link fetchCommonsImage} returns `undefined` when it cannot capture the
 * licence and the attribution — it does not return the image with the licence
 * missing. That is the plan's rule ("si no puedes capturar la licencia, no
 * importes la imagen") expressed where it cannot be forgotten, and it lines up
 * with `attributableImageSchema`, whose `external` arm cannot be constructed
 * without an `ImageLicence` at all.
 *
 * `sourceUrl` is the Commons FILE PAGE (`commons.wikimedia.org/wiki/File:…`),
 * never the raw `upload.wikimedia.org` bytes — the file page is what states the
 * author and licence, so it is the only URL that discharges attribution. The
 * shared schema refuses the raw host outright.
 */

import type { AttributableImage, ImageLicence } from '@syra/shared-types';
import {
  asArray,
  asRecord,
  asString,
  fetchEnrichmentJson,
  htmlToPlainText,
} from './enrichmentHttp';

/**
 * Width requested for the rendered copy.
 *
 * Commons originals are frequently 4000 px+ scans; 1000 px is comfortably above
 * what any profile surface renders and keeps the mirror download small. Commons
 * returns the ORIGINAL when it is already narrower rather than upscaling.
 */
const COMMONS_THUMBNAIL_WIDTH = 1000;

/**
 * Licence values that mean "not usable", even though the file sits on Commons.
 *
 * Commons hosts a small number of files under terms that forbid commercial reuse
 * or derivative works, mostly fair-use logos and non-free album art on local
 * wikis. Publishing one into a catalogue is exactly the reuse they exclude. The
 * match is on the short name Commons itself reports.
 */
const NON_FREE_LICENCE_PATTERN = /non-?free|fair ?use|no ?commercial|\bNC\b|\bND\b|copyright/i;

export interface CommonsImage {
  /** Direct URL to the rendered bytes — for the mirror step ONLY, never stored. */
  url: string;
  width?: number;
  height?: number;
  licence: ImageLicence;
}

/** `File:Foo.jpg` — Commons wants the namespace prefix on the API title. */
function toFileTitle(fileName: string): string {
  const trimmed = fileName.trim().replace(/^File:/i, '');
  return `File:${trimmed}`;
}

function readLicence(
  extmetadata: Record<string, unknown>,
  filePageUrl: string,
): ImageLicence | undefined {
  const readField = (key: string): string | undefined =>
    asString(asRecord(extmetadata[key])?.value);

  // `LicenseShortName` is the human short name ("Public domain", "CC BY-SA 4.0");
  // `License` is the machine slug ("pd", "cc-by-sa-4.0"). Either identifies the
  // terms, so a file carrying only one of them is still usable.
  const licence = readField('LicenseShortName') ?? readField('License');
  if (!licence) return undefined;

  if (NON_FREE_LICENCE_PATTERN.test(licence)) return undefined;

  // `Artist` is the author, as an HTML fragment (usually an anchor to a user
  // page). `Credit` is the source. Either can stand as the attribution; a file
  // with neither cannot be attributed, so it cannot be used.
  const attribution =
    (readField('Artist') ?? readField('Credit') ?? readField('Attribution'))
      ?.split('\n')
      .map((line) => htmlToPlainText(line))
      .find((line) => line.length > 0);
  if (!attribution) return undefined;

  const licenceUrl = readField('LicenseUrl');

  return {
    licence,
    ...(licenceUrl !== undefined && { licenceUrl }),
    attribution,
    sourceUrl: filePageUrl,
  };
}

/**
 * Look a Commons file up and return it only if it is usable.
 *
 * `undefined` covers every reason not to import: the file does not exist, it has
 * no licence we can read, its licence forbids commercial reuse, or nobody is
 * named to credit. The caller cannot tell these apart on purpose — all of them
 * mean the same thing at the call site, and none of them is recoverable by
 * trying harder.
 */
export async function fetchCommonsImage(fileName: string): Promise<CommonsImage | undefined> {
  const title = toFileTitle(fileName);
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
    `&iiprop=${encodeURIComponent('url|size|extmetadata')}` +
    `&iiurlwidth=${COMMONS_THUMBNAIL_WIDTH}` +
    `&titles=${encodeURIComponent(title)}`;

  const pages = asRecord(asRecord(asRecord(await fetchEnrichmentJson(url))?.query)?.pages);
  if (!pages) return undefined;

  for (const page of Object.values(pages)) {
    const record = asRecord(page);
    // A missing file comes back as a page with a negative id and a `missing` key
    // rather than as an error.
    if (!record || 'missing' in record) continue;

    const info = asRecord(asArray(record.imageinfo)[0]);
    if (!info) continue;

    const filePageUrl = asString(info.descriptionurl);
    if (!filePageUrl) continue;

    const extmetadata = asRecord(info.extmetadata);
    if (!extmetadata) continue;

    const licence = readLicence(extmetadata, filePageUrl);
    if (!licence) continue;

    // `thumburl` is the rendered copy at the requested width; `url` is the
    // original. Prefer the thumbnail — the original can be a 40 MB TIFF.
    const bytesUrl = asString(info.thumburl) ?? asString(info.url);
    if (!bytesUrl) continue;

    const width = asString(info.thumbwidth) ?? info.thumbwidth;
    const height = asString(info.thumbheight) ?? info.thumbheight;

    return {
      url: bytesUrl,
      ...(typeof width === 'number' && { width }),
      ...(typeof height === 'number' && { height }),
      licence,
    };
  }

  return undefined;
}

/** The stored shape: an external image that carries its licence with it. */
export function toAttributableImage(image: CommonsImage): AttributableImage {
  return {
    origin: 'external',
    url: image.url,
    ...(image.width !== undefined && { width: image.width }),
    ...(image.height !== undefined && { height: image.height }),
    provider: 'wikimedia-commons',
    licence: image.licence,
  };
}
