# Listener experience

## Public monthly audience

The artist header displays **unique signed-in Oxy accounts** that logged at least one qualified music play in the rolling **28-day** window. A qualified play uses Syra's existing rule: completion >= 0.3 and not skipped. The interval is `[computedAt - 28 days, computedAt)` in UTC. Repeated plays and different recordings by the same artist count once per account. Resolved performing credits (artist, albumartist, performer, featured, vocalist) also receive attribution; writing and production credits do not. Primary attribution uses the artist stored on the event. Historical credit attribution uses current resolved credits, so catalog corrections affect the next refresh.

The 30-minute maintenance tick materializes the aggregate under a PostgreSQL transaction advisory lock. Profile requests never scan listening history. The timestamp distinguishes an uncomputed metric from a genuine zero; every current refresh clears counts for artists with no audience. An older cutoff cannot overwrite an already newer snapshot, while equal-cutoff passes remain idempotent. Failures leave the last complete snapshot and are logged. Listening-event retention already exceeds the 28-day window.

Anonymous previews, podcasts, live streams and private uploads do not contribute. There is no device fingerprinting. These are account counts from reported playback, not an independently audited measure of humans or a guarantee against fake accounts. Followers and lifetime plays remain separate.

## Sharing and credits

Track, album, artist and playlist links use canonical Syra routes. Track links may contain a playback timestamp; seeking is performed only after an explicit play action. Lyric text is not copied into social cards. Credits preserve unknown roles and unresolved textual names instead of guessing identities.

## Collaborative playlists

Only the playlist owner creates or revokes invitations and manages member roles. Links expire after seven days; a playlist can have at most ten active links and fifty collaborators. Roles are `editor` or `viewer`, never `owner`. Accepting a link requires an explicit action by an authenticated account. Accepting another link does not upgrade an existing member's role.

Raw invitation tokens leave the server only when issued. PostgreSQL stores their SHA-256 digests, excluded by the protected-column registry. Revocation and acceptance serialize on the same playlist row. Membership is checked after acquiring that lock for editing as well, so a queued edit cannot use permissions revoked while it was waiting. Removing a member revokes outstanding invitation links to prevent immediate rejoining through an old link.

Activity reads are restricted to the owner and existing collaborators, including for public playlists. The UI displays the latest fifty events. Deleting a playlist cascades its invitations and activity. Invitation responses are private and non-cacheable.

## Queue and regression coverage

The library exposes history and a queue editor. Queue operations preserve occurrence identity when a recording appears twice. Invalid local operations do not invalidate an outstanding valid server write. A late response from an earlier account or queue revision cannot overwrite the active queue. Account-scoped snapshots hydrate metadata without starting audio. Seek jumps are not reported as time spent listening.

Regression coverage includes monthly-window boundaries and deduplication, rendered unknown/zero/positive audience states, resolved and unresolved credits, account and queue response races, invitation expiry/revocation, repeated acceptance, member limits, and edits queued behind a role revocation. Database tests run against migrated PostgreSQL, not a mocked permission check. Type checking is a separate check for all five packages.

The native audio engine and real-device playback are separate validation surfaces; a green TypeScript or Jest result does not assert that they were exercised.

## Rollout

`0032_listener_experience` adds the nullable audience timestamp and the two collaboration tables. It is a pre-deploy additive migration; new-table foreign keys are declared at creation. Main's already-published `0031_bouncy_victor_mancha` and its image indexes remain unchanged. After migration and backend rollout, the regular maintenance scheduler fills the audience timestamp; the header does not invent a zero while waiting for that first pass.

## Issue 140 completion audit

The unified profile keeps the monthly audience immediately beneath the artist name inside one responsive hero. Its skeleton reserves that same row. Computed zero is displayed; an absent timestamp is unknown, never replaced with follower totals. Artist controls provide play/pause, shuffle and follow, with radio/share in one overflow menu and labelled touch targets. Track overflow includes queue placement, playlist addition, canonical artist/album navigation, sharing and credits/lyrics.

Public popular-track ranking uses stored popularity first, creation date second and identity as a deterministic tie-breaker; artwork presence no longer outranks the score. Release lists sort newest first, not artwork first, and shelves remain bounded with explicit expansion. The existing popularity pipeline is reused rather than introducing an unreviewed second score. Related artists come only from real co-listen edges or shared genres, with that explanation shown beside the shelf. Unrelated popularity filler was removed; sparse catalogs may legitimately have no related shelf.

The full About section displays stored biography, disambiguation, partial active dates, aliases, labels and members. Resolved members link to their profiles; unresolved names stay text. A displayed photo's authorship, licence and safe source link are visible. Missing dates never imply continued activity. New labels are supplied in all sixteen listener locales. Viewer-sensitive profile shelves use the linked API client, preserving permission checks for private readable playlists.

Track credits include the catalog's known primary artist even when the child credit list is empty. An explicit matching primary credit is not duplicated. Other roles and unresolved contributors remain factual, and copyright/publisher metadata is preserved.

Lyrics retain a track-keyed query for 24 hours of both freshness and inactive cache lifetime. Scrubbing does not change the key. A 404 is cached as unavailable; other errors remain retryable. The provider request is bounded to ten seconds, the client allows twelve seconds, and query retries are bounded. Corrupt provider responses are errors, not fabricated absence. Invalid timed content can fall back to real plain lyrics; empty plain fields can fall back to stored text lines. A genuinely empty record has an unavailable state. Highlighting/seeking is restricted to the current track, with selected/disabled accessibility states and source attribution. Lyric text sharing is not enabled.

Focused regressions live in `monthly-listeners.test.ts`, `relatedArtists.test.ts`, `entityProfile.artistSections.test.ts`, `LrclibProvider.test.ts`, `lyricsService.test.ts`, `artist-profile-details.test.tsx`, `artist-listener-metadata.test.tsx`, `useLyrics.test.tsx`, `LyricsView.test.tsx` and `entityService.test.ts`. Run them through the repository's Quality workflow, including all-package typechecks, frontend/Studio tests, migrated-PostgreSQL backend tests and the listener web export. Device audio validation remains a separate surface, not implied by those checks.

## Focused follow-ups from section 5

As requested by #140, larger roadmap work is tracked separately rather than silently included in its completion claim:

- #153: offline music downloads and storage/entitlement management.
- #154: real gapless/crossfade behavior and truthful loudness preferences, building on existing encoding.
- #155: cross-client Connect handoff validation and race recovery, building on existing Connect.
- #156: artist-selected playlist shelves, distinct from playlists merely containing the artist.
- #157: consent-aware release notifications.
- #158: rights-aware generated social artwork; lyric sharing requires a rights review.
- #159: mutually opted-in taste-match and shared recommendation playlists.
- #160: permissioned external playlist metadata import.

History, canonical link sharing, queue persistence and explicit playlist collaboration were already present in main before the final #140 audit and are retained, not claimed as new subsystems here. This final audit adds no database migration and does not rewrite existing migration history.
