# Generated episodes

A creator, or an agent acting for them, asks Syra to write and voice an episode of a show
they own. It becomes an ordinary hosted episode of that show: in its RSS feed, playable in the
app and in Studio, deleted with the show. Syra owns the whole feature; Gemies and Alia have
none of it (they reach it through [Syra's MCP server](./mcp.md)).

## How one episode is made

```text
POST /api/podcasts/:id/episodes/generate      (Studio)    ─┐
MCP generate-episode                          (any agent) ─┴─> requestEpisodeGeneration
   -> caps, profile, reserve episode N (processing) + its job -> ingest queue
runEpisodeGeneration (worker)
   writing     Kaana responses, `medium` power level, JSON with repair
   recording   Kaana speech, one line at a time, in the show's cast
   assembling  ffmpeg: one MP3, one loudness; ffprobe measures the duration
   publishing  putSourceAudio + ingestEpisode, exactly as an upload
   completed   the episode's own status (ready, or failed) is ingest's
```

| Code | Does |
|---|---|
| `services/podcasts/generation/request.ts` | the one entry point: ownership is the caller's (`findPodcastForOwner`); caps; first-episode profile; reserve; enqueue |
| `services/podcasts/generation/pipeline.ts` | script → voices → file → source audio → `ingestEpisode` |
| `services/podcasts/generation/script.ts` | the prompts and the script parser |
| `services/podcasts/generation/speech.ts` | casting from Kaana's catalogue; speakable text; splitting a long line |
| `services/podcasts/generation/kaana.ts` | the Kaana client ([AI routing](./ai-routing.md)) |
| `db/schema/podcastGeneration.ts`, `db/podcasts/generations.ts` | the two tables and their reads |
| `controllers/episodeGeneration.controller.ts` | the REST routes |

The job runs on the ingest queue (`services/ingest/ingestQueue.ts`, kind `episode-generation`)
with **one attempt**: every attempt spends inference, and a failure is recorded on the job
(`error`, in words for the owner) with the episode marked `failed`, never left at
`processing`. A job delivered again after it finished does nothing.

## A show's memory

`podcast_generation_profiles` holds, per show, its **brief** (what it is about, in the
owner's words; the show's description on its first episode when no brief is given), its
**format** (`podcast`, `news`, `debate`, `interview`, `explainer`) and its **cast**: one
distinct voice per role, from the first speech model Syra's Kaana catalogue lists with enough
voices, alternating gender where the catalogue publishes it. The on-air names are the
voices' own names. The cast never changes: a show whose hosts changed voice between episodes
would be absurd.

`episode_generations` holds, per episode, what it covers (`topic`: the one asked for, or the
one the script chose) and its `recap`. The next episode is told **every** earlier subject in
one line, so it does not repeat one, and the **last three** recaps in full, so it picks up
where they left off. A failed run is left out of that memory; one still running is kept,
because it has already claimed its subject.

"Another episode" is one press: with a brief on the profile, every field is optional. A
topic, a title and source notes are optional overrides: supplied, they are used as given;
absent, the script decides. A title the owner did not give comes from the finished script,
and `Episode {n}` stands when the script names nothing usable.

## Limits and billing

Per person: **3** generations running at once and **20** a UTC day
(`MAX_ACTIVE_GENERATIONS`, `MAX_DAILY_GENERATIONS`). Every Kaana request is attributed to
that person and admitted by Oxy under Syra's terms; Syra keeps no ledger of its own.

## Audio ownership

From Studio, the owner's session is on the request, so the episode gets an Oxy file task like
an upload and the finished audio becomes the owner's own Oxy file. An MCP connection carries
no session, so its episodes keep Syra's copy of the audio (the progressive `/audio` path for a
private show, the HLS ladder for a public one) until Oxy offers MCP callers a way to admit a
personal file.

## Routes

```text
POST /api/podcasts/:id/episodes/generate     { topic?, title?, notes?, brief?, format? } -> 202
GET  /api/podcasts/:id/generations           the show's generations, newest first
GET  /api/podcasts/episodes/:id/generation   one generation
```

All three are the owner's only; anybody else's show answers like no show at all.
