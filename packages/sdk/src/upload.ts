import { SyraApiError } from './errors';
import type { AudioUploadTarget } from './types';

/**
 * An audio or image payload, in the shapes the three supported runtimes give you.
 *
 * `Blob`/`File` covers browsers and Node 18+. React Native's `FormData` accepts
 * a `{ uri, name, type }` descriptor instead, which is not a `Blob` at all — it
 * is named here so an RN caller does not have to cast, and so this SDK never has
 * to import anything from React Native to support it.
 */
export type UploadPayload = Blob | { uri: string; name?: string; type?: string };

/**
 * Append an upload to a `FormData`, in whichever shape the runtime gave us.
 *
 * The RN `{ uri, name, type }` descriptor is not a `Blob` and the DOM
 * `FormData.append` signature does not admit it, so it goes through one cast
 * confined to this function — rather than every call site, or a `declare
 * module` shim that would shadow the real DOM types in every consumer. React
 * Native streams the file from disk itself; nothing is read into JavaScript.
 */
export function appendUpload(
  form: FormData,
  field: string,
  payload: UploadPayload,
  filename?: string,
): void {
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    form.append(field, payload, filename);
    return;
  }
  const descriptor = payload as { uri: string; name?: string; type?: string };
  const name = filename ?? descriptor.name ?? field;
  form.append(field, descriptor as unknown as Blob, name);
}

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
};

/**
 * The type to declare for an audio payload: its own, else the one its file name
 * implies, else `audio/mpeg`. A signed upload form admits exactly the type it was
 * signed for, so the type has to be known BEFORE the file is sent.
 */
export function audioMimeType(payload: UploadPayload, filename?: string): string {
  const own =
    typeof Blob !== 'undefined' && payload instanceof Blob
      ? payload.type
      : (payload as { type?: string }).type;
  if (own) return own;
  const name = filename ?? (payload as { name?: string }).name ?? '';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return AUDIO_MIME_BY_EXTENSION[extension] ?? 'audio/mpeg';
}

export interface SendAudioUploadOptions {
  /**
   * Called as bytes leave the device, with the fraction sent (0–1). Reported
   * continuously where the runtime has `XMLHttpRequest` (browsers, React
   * Native); elsewhere once, at 1, when the upload completes.
   */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /**
   * Send with this `fetch` instead of `XMLHttpRequest`. The SDK client passes
   * its own, so a worker on Node (which has no `XMLHttpRequest`) and a test
   * double both see the request.
   */
  fetch?: typeof fetch;
}

/** Storage's own refusal code, out of its XML error body (`EntityTooLarge`…). */
function storageErrorCode(body: string): string | undefined {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
}

function refusal(status: number, body: string): SyraApiError {
  const code = storageErrorCode(body);
  const reason =
    code === 'EntityTooLarge'
      ? 'the file is larger than this upload allows'
      : code === 'AccessDenied' || code === 'SignatureDoesNotMatch'
        ? 'storage refused the upload (an expired URL, or a size or type other than was signed)'
        : (code ?? `status ${status}`);
  return new SyraApiError(status, `Syra upload to storage failed: ${reason}`);
}

function sendWithXhr(
  target: AudioUploadTarget,
  body: Blob,
  options: SendAudioUploadOptions,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        body: typeof xhr.responseText === 'string' ? xhr.responseText : '',
      });
    xhr.onerror = () =>
      reject(new SyraApiError(0, 'Syra upload to storage failed: the network request failed'));
    xhr.onabort = () => {
      const aborted = new Error('The upload was aborted');
      aborted.name = 'AbortError';
      reject(aborted);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        xhr.abort();
        return;
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

/**
 * The payload as a `Blob`. A React Native `{ uri }` descriptor is read through
 * `fetch`, which on Android holds the whole file in memory — so an app with a
 * large file on a device streams it from disk instead (`expo-file-system`'s
 * `File.upload` with the same URL and headers) and calls this only on the web.
 */
export async function payloadBlob(payload: UploadPayload, doFetch: typeof fetch): Promise<Blob> {
  if (typeof Blob !== 'undefined' && payload instanceof Blob) return payload;
  const response = await doFetch((payload as { uri: string }).uri);
  return response.blob();
}

/**
 * Send one audio file to the presigned PUT an upload request answered with —
 * straight to storage, never through the Syra API, which refuses request bodies
 * over 100 MB. Resolves once storage has the file; complete the upload by
 * `target.uploadId` afterwards. Throws a `SyraApiError` carrying storage's
 * status when storage refuses it (another size or type than was signed, an
 * expired URL).
 */
export async function sendAudioUpload(
  target: AudioUploadTarget,
  payload: UploadPayload,
  options: SendAudioUploadOptions = {},
): Promise<void> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const body = await payloadBlob(payload, doFetch);

  let status: number;
  let responseBody = '';
  if (!options.fetch && typeof XMLHttpRequest !== 'undefined') {
    ({ status, body: responseBody } = await sendWithXhr(target, body, options));
  } else {
    const response = await doFetch(target.url, {
      method: target.method,
      headers: target.headers,
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    status = response.status;
    if (!response.ok && typeof response.text === 'function') {
      responseBody = await response.text().catch(() => '');
    }
  }

  if (status < 200 || status >= 300) throw refusal(status, responseBody);
  options.onProgress?.(1);
}
