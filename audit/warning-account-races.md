# Persistent retry warning: observed races

The first candidate on top of Syra main 3d3385d set `outcomeUnknown = true`
in the playlist mutation's `onError` and displayed a persistent generic alert.
Before removing the candidate, the screen integration tests with real
QueryClient, OxyServices and linked transport reproduced all three failures:

1. A's request failed and displayed the alert; after switching the token and
   visible account to B, the same mounted screen still displayed A's alert.
2. A's request was held, the token and visible account changed to B, then A's
   fetch rejected. A's callback set the alert while B was visible.
3. The same request was held through A -> B -> A before rejecting; the stale
   callback set the alert in the later A session.

All three tests asserted that the new session had zero alert elements and failed
with one. The candidate state and translation changes were removed from the
independent fix. The account-owned warning needs the stronger owner and session
guard in #267, with Core 7.9.1 or newer; no claim is made that a generic
unscoped toast or Core 7.3 closes the issue.
