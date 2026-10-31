# Playlist creation retries

The backend inserts a new playlist for every create request and does not accept
an idempotency key. If the response is lost after the server has accepted the
request, an automatic retry can create a duplicate. The create mutation opts out
of TanStack Query's global retry policy while still allowing an offline mutation
to run when the same session reconnects.

A failed or lost response is not proof that the playlist was not created.
Before retrying manually, check the account's playlist library. This change does
not provide server-side idempotency or isolate callbacks across account changes;
those are separate concerns.
