# Syra AI routing

Syra calls inference for one product feature, [generated episodes](./podcast-generation.md),
and it reaches it one way:

```text
Syra API (its Oxy workload) -> @kaana.ai/sdk/server -> Kaana -> provider
                                   Oxy admits, meters and bills every request
```

- **Kaana's SDK, over Syra's own Oxy workload.** `services/podcasts/generation/kaana.ts`
  builds the client with `kaanaForOxyService(oxy, { attribution: { accountId } })`: the
  workload identity of `oxyClient.ts`, no API key, no scope list, no token plumbing. The SDK
  owns Kaana's one canonical origin; Syra never names a host (the gate below refuses one).
- **Attributed to the person.** Every client is attributed to the account the episode is
  for, so their usage is recorded against them. Attribution is not a payer: Oxy admits the
  request under Syra's application and its reviewed terms (oxy
  `config/inferenceEconomicPolicy.ts`, relationship `syra-kaana-shows`).
- **Power levels and the catalogue, never a configured model.** A script is written at the
  `medium` power level and Kaana picks the model. Speech needs a concrete model, because a
  voice belongs to one: a show is cast once from the first speech model Syra's Kaana
  catalogue lists with enough voices, and that model is stored on the show's generation
  profile, never in code or environment.
- **No provider credential, adapter, retry loop or failover list in Syra.** Kaana retries and
  fails over before the first byte. The pipeline asks again only when a reply is not a usable
  script (once); a failure is recorded on the job for the owner and never retried by itself.

Conversations and autonomous agents belong to Gemies. An agent that wants to make an
episode does it through [Syra's MCP server](./mcp.md), as any other client does.

Recommendations and radio are deterministic PostgreSQL computations over listening activity
and catalogue data. AcoustID, MusicBrainz, Cover Art Archive, Wikidata, Wikimedia Commons,
Deezer, LRCLIB, Podcast Index, Jamendo, KLIPY, storage, LiveKit, Telegram and CrowdSource are
music, media, communications, moderation or operational integrations, not inference
providers.

`bun run validate:ai-architecture` rejects direct inference SDK dependencies or imports,
well-known model-provider endpoints, an inference data-plane host named anywhere but through
the `@kaana.ai/sdk` package (retired hosts included), and inference-provider credential
variables. Its mutation harness proves each negative rule and the legitimate cases.
