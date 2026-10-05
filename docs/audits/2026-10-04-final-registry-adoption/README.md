# Syra: published SDK adoption

Source `2a44e7bdc1761d3586c71f3de3b66ecbb3f5ecf7` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"receiverPassed": 1, "sdkImporterMembers": 8997, "bloomImporterMembers": 62820, "typesBuildExport": "passed"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Receiver uses a loopback-only synthetic issuer in an isolated child.
- Filtered receiver tests are not full-suite acceptance. Syra notifications retain their pre-existing scope denial; no permission expansion. TNP DNS/relay checks do not claim an API image was deployed.
