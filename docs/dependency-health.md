# Dependency health

Run `bun run doctor:oxy` to compare direct `@oxy.so/*` dependencies with npm and
detect duplicate Oxy versions in `bun.lock`. CI runs the same read-only check;
it never edits manifests or installs updates.

Dependabot updates pinned GitHub Actions weekly. JavaScript dependencies use a
Bun lockfile, so Oxy updates are applied with `bun update`, tested normally and
reviewed before merge. Runtime auto-updates and `latest` dependency ranges are
not used.
