# Listener experience

## Public monthly audience

The artist header displays **unique signed-in Oxy accounts** that logged at least one qualified music play in the rolling **28-day** window. A qualified play uses Syra's existing rule: completion >= 0.3 and not skipped. The interval is `[computedAt - 28 days, computedAt)` in UTC. Repeated plays and different recordings by the same artist count once per account. Resolved performing credits (artist, albumartist, performer, featured, vocalist) also receive attribution; writing and production credits do not. Primary attribution uses the artist stored on the event. Historical credit attribution uses current resolved credits, so catalog corrections affect the next refresh.

The 30-minute maintenance tick materializes the aggregate under a PostgreSQL transaction advisory lock. Profile requests never scan listening history. The timestamp distinguishes an uncomputed metric from a genuine zero; every refresh clears counts for artists with no audience. Failures leave the last complete snapshot and are logged. Listening-event retention already exceeds the 28-day window.

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

This change covers profiles, credits, lyrics, history, queue persistence, canonical link sharing and explicit playlist collaboration. Offline audio downloads, new crossfade/gapless engines, taste-match generation, external playlist import, creator-selected playlist shelves, release notifications and generated social artwork are separate outstanding parts of issue #140. Existing device-connect and encoding functionality is not claimed as newly implemented here.
