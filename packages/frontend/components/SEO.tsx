import React from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

type HeadComponent = React.ComponentType<{ children?: React.ReactNode }>;

// Only import Head on web to avoid native errors
let Head: HeadComponent | null = null;
if (Platform.OS === 'web') {
  try {
    // Try multiple import methods for compatibility
    const expoRouterHead = require('expo-router/head') as {
      Head?: HeadComponent;
      default?: HeadComponent;
    };
    Head = expoRouterHead.Head ?? expoRouterHead.default ?? null;
  } catch (e) {
    // Head not available - will return null component
    console.warn('SEO: expo-router/head not available', e);
  }
}

export interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'profile';
  siteName?: string;
  twitterHandle?: string;
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
}

/** Canonical production origin, used when there is no `window` to read (native, prerender). */
const SITE_ORIGIN = 'https://syra.fm';

const defaultSEO = {
  siteName: 'Syra',
  type: 'website' as const,
};

export const SEO: React.FC<SEOProps> = ({
  title,
  description,
  image,
  url,
  type = 'website',
  siteName,
  // No default handle: Syra has no verified X/Twitter account, and the tags below
  // are omitted entirely rather than pointing at someone else's.
  twitterHandle,
  author,
  publishedTime,
  modifiedTime,
}) => {
  const pathname = usePathname();
  const { t } = useTranslation();

  // Generate full URL
  const fullUrl = url || (Platform.OS === 'web' && typeof window !== 'undefined'
    ? `${window.location.origin}${pathname}`
    : `${SITE_ORIGIN}${pathname}`);

  // Use provided siteName or translated default
  const finalSiteName = siteName || t('seo.siteName', { defaultValue: defaultSEO.siteName });

  // Default title if not provided (translated)
  const pageTitle = title || t('seo.defaultTitle', { defaultValue: `${finalSiteName} - Music and podcasts` });

  // Default description if not provided (translated)
  const pageDescription = description || t('seo.defaultDescription', {
    defaultValue: `Stream music, podcasts and live audio rooms on ${finalSiteName}.`,
    siteName: finalSiteName
  });

  // There is no Syra share image in the repo yet, so pages without an explicit
  // `image` ship no image tags at all — an absent card degrades gracefully, while
  // a broken or foreign URL renders as a broken card. Add a 1200x630 asset and
  // default it here to turn large summary cards back on everywhere.
  const pageImage = image;

  // Only render on web
  if (Platform.OS !== 'web' || !Head) {
    return null;
  }

  return (
    <Head>
      {/* Primary Meta Tags */}
      <title>{pageTitle}</title>
      <meta name="title" content={pageTitle} />
      <meta name="description" content={pageDescription} />
      
      {/* Open Graph / Facebook */}
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={pageDescription} />
      {pageImage && <meta property="og:image" content={pageImage} />}
      <meta property="og:site_name" content={finalSiteName} />

      {/* Twitter Card — a large-image card without an image renders as a broken
          box, so fall back to the text-only card when there is no image. */}
      <meta name="twitter:card" content={pageImage ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:url" content={fullUrl} />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={pageDescription} />
      {pageImage && <meta name="twitter:image" content={pageImage} />}
      {twitterHandle && <meta name="twitter:site" content={twitterHandle} />}
      {twitterHandle && <meta name="twitter:creator" content={twitterHandle} />}
      
      {/* Article specific tags */}
      {type === 'article' && (
        <>
          {author && <meta property="article:author" content={author} />}
          {publishedTime && <meta property="article:published_time" content={publishedTime} />}
          {modifiedTime && <meta property="article:modified_time" content={modifiedTime} />}
        </>
      )}
      
      {/* Additional meta tags */}
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="canonical" href={fullUrl} />
    </Head>
  );
};

export default SEO;

