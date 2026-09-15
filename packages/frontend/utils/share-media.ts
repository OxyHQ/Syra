import { Share, Platform } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import i18n from 'i18next';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('ShareMedia');
const PUBLIC_APP_URL = process.env.EXPO_PUBLIC_APP_URL ?? 'https://syra.fm';
export type ShareKind = 'track' | 'album' | 'p' | 'playlist';

export function mediaShareUrl(kind: ShareKind, id: string, seconds?: number): string {
  const url = new URL(`/${kind}/${encodeURIComponent(id)}`, PUBLIC_APP_URL);
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    url.searchParams.set('t', String(Math.floor(seconds)));
  }
  return url.toString();
}

/** Share a link and metadata, not licensed lyric text or audio bytes. */
export async function shareMedia(kind: ShareKind, id: string, title: string, seconds?: number): Promise<void> {
  const url = mediaShareUrl(kind, id, seconds);
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast.success(i18n.t('listener.linkCopied'));
      } else {
        throw new Error('Sharing is unavailable in this browser');
      }
      return;
    }
    await Share.share({ title, message: `${title}\n${url}`, url });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return;
    logger.warn('Sharing failed', { error });
    toast.error(i18n.t('listener.shareFailed'));
  }
}
