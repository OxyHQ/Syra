# Listener experience

## Public monthly audience

The artist header displays **unique signed-in Oxy accounts** that logged at least one qualified music play in the rolling **28-day** window. A qualified play uses Syra's existing rule: completion >= 0.3 and not skipped. The interval is `[computedAt - 28 days, computedAt)` in UTC. Repeated plays and different recordings by the same artist count once per account. Resolved performing credits (artist, albumartist, performer, featured, vocalist) also receive attribution; writing and production credits do not. Primary attribution uses the artist stored on the event. Historical credit attribution uses current resolved credits, so catalog corrections affect the next refresh.

The 30-minute maintenance tick materializes the aggregate under a PostgreSQL transaction advisory lock. Profile requests never scan listening history. The timestamp distinguishes an uncomputed metric from a genuine zero; every refresh clears counts for artists with no audience. Failures leave the last complete snapshot and are logged. Listening-event retention already exceeds the 28-day window.

Anonymous previews, podcasts, live streams and private uploads do not contribute. There is no device fingerprinting. These are account counts from reported playback, not an independently audited measure of humans or a guarantee against fake accounts. Followers and lifetime plays remain separate.

## Sharing and credits

Track, album, artist and playlist links use canonical Syra routes. Track links may contain a playback timestamp; seeking is performed only after an explicit play action. Lyric text is not copied into social cards. Credits preserve unknown roles and unresolved textual names instead of guessing identities.
