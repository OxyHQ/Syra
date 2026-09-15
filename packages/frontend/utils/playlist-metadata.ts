import { playlistImportPreviewRequestSchema, type PlaylistImportEntry } from '@syra/shared-types';

export const PLAYLIST_METADATA_MAX_BYTES = 1024 * 1024;

/** RFC-style quoting, including escaped quotes, commas and newlines in fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length || closed) throw new Error('tools.importInvalid');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = ''; closed = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; field = ''; closed = false;
      if (rows.length > 501) throw new Error('tools.importLimit');
    } else {
      if (closed) throw new Error('tools.importInvalid');
      field += char;
    }
  }
  if (quoted) throw new Error('tools.importInvalid');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function metadataEntry(value: unknown): PlaylistImportEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tools.importInvalid');
  const fields = new Map(Object.entries(value).map(([key, item]) => [key.toLowerCase().replace(/[^a-z]/g, ''), item]));
  const read = (...keys: string[]) => {
    const match = keys.map((key) => fields.get(key)).find((entry) => typeof entry === 'string' && entry.trim());
    return typeof match === 'string' ? match.trim() : undefined;
  };
  return { catalogId: read('catalogid', 'syraid'), isrc: read('isrc'), title: read('title', 'trackname', 'name'), artist: read('artist', 'artistname', 'artistnames', 'artists') };
}

/** Import metadata, never provider credentials, a stream URL, or external audio. */
export function parsePlaylistMetadata(raw: string): PlaylistImportEntry[] {
  if (new TextEncoder().encode(raw).byteLength > PLAYLIST_METADATA_MAX_BYTES) throw new Error('tools.importLimit');
  const text = raw.replace(/^\uFEFF/, '').trim();
  let values: unknown;
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'tracks' in parsed ? parsed.tracks : parsed;
    } catch { throw new Error('tools.importInvalid'); }
  } else {
    const [headers, ...rows] = parseCsv(text);
    if (!headers?.length) throw new Error('tools.importInvalid');
    if (new Set(headers.map((header) => header.trim().toLowerCase())).size !== headers.length) throw new Error('tools.importInvalid');
    values = rows.map((row) => {
      if (row.length !== headers.length) throw new Error('tools.importInvalid');
      return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    });
  }
  if (!Array.isArray(values) || !values.length || values.length > 500) throw new Error('tools.importLimit');
  const result = playlistImportPreviewRequestSchema.safeParse({ entries: values.map(metadataEntry) });
  if (!result.success) throw new Error('tools.importInvalid');
  return result.data.entries;
}
