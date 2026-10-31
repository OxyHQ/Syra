# Playlist creation and account transitions

A queued playlist creation must belong to the session and visible account that
produced the form. The creation screen captures the SDK epoch and account at
render, rejects obsolete work before calling the service, and suppresses stale
success and error effects. It also resets the form when the session, bearer
subject or visible account changes. The checks use Core's session subject and
fail closed when it cannot be matched; the screen shows a localized message in
that case. Tokens without `userId` or `id`, including opaque and sub-only
bearers, therefore cannot create a playlist through this screen.

The update to Core 7.9.1 is part of this protection: older Core could receive a
late 401 from A, refresh using B, and retry A's request as B. This screen guard
alone cannot fence that internal HTTP retry. A request already accepted by a
server cannot be undone by changing sessions.

This change does not clear unregistered mutations, migrate old persisted work,
or protect other mutation screens. The SDK's existing shared persistence can
still contain old or new unregistered mutation records. A queued action from a
replaced session is rejected if it resumes; there is no promise that its input
can be recovered as a draft. Preserving or attributing legacy work requires a
separately reviewed migration and storage design.

The web export must continue to meet the existing `performance-budgets.json`.
An isolated export after the SDK update but before the final UI change exceeded
initial JS by 21,011 bytes, initial gzip by 6,737 bytes, and deferred gzip by
549 bytes. Those measurements are not a pass for the final changes. Do not
merge or deploy until the current export passes the unchanged budget.
