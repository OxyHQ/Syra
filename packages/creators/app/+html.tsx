import { getSsoCallbackBootstrapScript } from '@oxyhq/core';
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

// SSO callback bootstrap. The SDK intercepts `/__oxy/sso-callback` universally;
// this inline script runs before the app boots so the callback is consumed
// without a flash. Defined once in @oxyhq/core — never reimplement locally.
const SSO_CALLBACK_BOOTSTRAP_SCRIPT = getSsoCallbackBootstrapScript();

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Syra for Creators</title>
        <meta name="application-name" content="Syra for Creators" />
        <script dangerouslySetInnerHTML={{ __html: SSO_CALLBACK_BOOTSTRAP_SCRIPT }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
