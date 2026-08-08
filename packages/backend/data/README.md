# `podcast-feeds.txt` — the one thing the cutover cannot rebuild

The Postgres migration is a **clean start**: production data is not migrated and
Postgres begins empty (`docs/superpowers/specs/2026-08-05-syra-mongo-to-postgres-design.md`
§"Decision: clean start, no backfill"). That decision is much cheaper than the
plan's "~594,000 documents" framing suggests, and it is worth writing down what
is actually at stake, measured against production on 2026-08-09:

| collection | count | rebuildable? |
|---|---|---|
| `tracks` | **3** | yes — creator uploads, and there are three |
| `albums` | 3 | yes |
| `podcasts` | 1,360 | **yes, from this file** |
| `episodes` | 271,193 | **yes** — derived from the feeds |
| `imageassets` | 321,450 | yes — derived from the above |
| `usersettings` | 6 | **no** |
| `userlibraries` | 1 | **no** |
| `usermusicpreferences` / `usertasteprofiles` | 1 each | **no** |
| `recentlyplayeds` / `listeningevents` | 100 / 105 | **no** |
| `episodeprogresses` | 13 | **no** |

The music catalogue is three tracks — Syra is upload-only and barely seeded, so
"we lose the music" is not the risk anyone imagines. **The 271,193 episodes look
like the loss and are not**: podcasts are a MIRROR of external RSS, and
`importFeed` (`src/services/podcasts/podcastImportService.ts`) says so — *"Fetch a
feed and mirror it into the catalog. Idempotent: re-running upserts the same
show/episodes."* Given the feed URLs, the entire podcast catalogue rebuilds
itself.

**So the feed URLs are the irreplaceable input, and they are 68 KB.** This file is
them, exported from production before the cutover: 1,358 unique URLs from the
1,360 `podcasts` rows. Re-import drives them through the same path the app uses
(`POST /api/podcasts/import`, or `importFeed` directly), which is idempotent, so
running it twice is safe and resuming a half-finished run needs no bookkeeping.

What genuinely does not survive is the user state in the lower half of the table:
settings, one library, listening history, episode progress. It is small — six
settings documents — but it is real, and it is the part worth an explicit
decision rather than an assumption.
