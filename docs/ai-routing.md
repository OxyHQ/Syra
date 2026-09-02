# Syra AI routing

Syra does not call an inference provider or Kaana directly and does not hold
inference-provider credentials. The product boundary is:

- A future one-shot Syra AI operation runs on the Syra backend and calls the Oxy
  inference edge through `@oxyhq/core`. It uses Syra's Oxy application/service
  credential and supplies the delegated Oxy user only when the request is made
  on that user's behalf. The application credential determines billing; the
  delegated user is attribution, not a substitute credential.
- A conversation or autonomous agent belongs to Alia. A Syra client integrates
  the canonical Alia SDK only after its contract is published and the
  corresponding Alia agent/bot identity is provisioned. Syra must not invent or
  sort by an agent, routing-profile, deployment, provider, or model identifier.
- Kaana is reached only behind Oxy. Provider-key custody and provider adapters
  belong to Kaana's PostgreSQL/KMS boundary, never to Syra configuration.

There is no active Syra inference operation or conversational assistant at this
revision, so there is no honest model/profile/agent identifier to configure and
no unused inference client is constructed. Adding a product flow requires its
provisioned Oxy application capability and default routing policy (one-shot), or
its provisioned Alia agent/bot contract (conversation), in the same change.

## Existing integrations that remain

Alia authors podcast material outside Syra and calls the authenticated Syra SDK
to create shows, draft episodes, redeem ingest tickets, and delete them. Syra's
`provider = 'alia'`, `aliaSeriesId`, and `aiGenerated` fields are provenance and
disclosure; they are not an inference adapter. The direction is Alia to Syra,
not Syra to Alia or Kaana.

Recommendations/radio are deterministic PostgreSQL computations over listening
activity and catalogue data. AcoustID, MusicBrainz, Cover Art Archive, Wikidata,
Wikimedia Commons, Deezer, LRCLIB, Podcast Index, Jamendo, KLIPY, storage,
LiveKit, Telegram, and CrowdSource are music, media, communications, moderation,
or operational integrations. They are not inference providers and their
product-specific credentials and adapters are deliberately unaffected.

`bun run validate:ai-architecture` rejects direct inference SDK dependencies or
imports, well-known model-provider endpoints, direct current or retired
inference data-plane endpoints, and inference-provider credential variables.
Its mutation harness proves each negative rule and the legitimate
metadata/Alia/Oxy cases.
