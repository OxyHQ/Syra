import { getSsoCallbackBootstrapScript } from '@oxyhq/core';
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const SSO_CALLBACK_BOOTSTRAP_SCRIPT = getSsoCallbackBootstrapScript();

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Syra</title>
        <meta name="application-name" content="Syra" />
        <script dangerouslySetInnerHTML={{ __html: SSO_CALLBACK_BOOTSTRAP_SCRIPT }} />
        {/* Google Cast CAF Web Sender SDK — loads `window.cast`/`window.chrome`
            so the web cast service (services/cast/castService.web.ts) can report
            cast support and drive Chromecast receivers. */}
        <script defer src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
