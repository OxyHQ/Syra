# Syra DMCA Policy & Safe-Harbor Posture

> **Scope:** This document describes Syra's Digital Millennium Copyright Act (DMCA) safe-harbor posture (17 U.S.C. § 512), the notice-and-takedown workflow, and the repeat-infringer termination policy. This is an internal operational document; the public-facing version should be reviewed by qualified legal counsel before publication.

---

## 1. Safe-Harbor Eligibility (§ 512(c))

Syra operates as an Online Service Provider (OSP) that hosts user-uploaded audio content. To qualify for DMCA safe harbor:

1. Syra must not have actual knowledge that the content is infringing, and must act expeditiously to remove infringing content upon obtaining such knowledge.
2. Syra must not receive a financial benefit directly attributable to infringing activity when it has the right and ability to control such activity.
3. **Syra must designate an agent to receive DMCA notices** and register that agent with the U.S. Copyright Office.
4. Syra must have a reasonably implemented repeat-infringer termination policy.

---

## 2. Designated Agent Registration

**Action required before launch:**

1. Register a Designated Agent at the U.S. Copyright Office DMCA Designated Agent Directory:  
   [https://www.copyright.gov/dmca-directory/](https://www.copyright.gov/dmca-directory/)
2. Publish the agent's contact information on Syra's public-facing website (typically at `/dmca` or in the Terms of Service footer).

**Placeholder contact (replace with real details):**

```
DMCA Designated Agent
Syra / Oxy
Email: dmca@oxy.so
Mailing address: [Company address]
```

The agent's contact details must be kept current in the Copyright Office directory. Annual renewal may be required.

---

## 3. Notice-and-Takedown Workflow

### 3.1 Receiving a DMCA Notice

A valid DMCA takedown notice (§ 512(c)(3)) must include:

- Identification of the copyrighted work claimed to be infringed.
- Identification of the allegedly infringing material and its location on Syra (URL or track ID).
- Contact information for the complaining party.
- A statement of good faith belief that the use is not authorized.
- A statement under penalty of perjury that the information is accurate and the sender is authorized to act for the copyright owner.
- Physical or electronic signature.

**Do not process notices that lack any of the above elements.** Request the missing information from the sender.

### 3.2 Expeditious Takedown

Upon receiving a valid notice:

1. Log the report via `POST /api/copyright/report` (maps to `CopyrightReportModel`).
2. Mark the track `copyrightRemoved: true` and set `removedAt`, `removedReason`, `removedBy` on the `Track` document.
3. Remove the content from public playback immediately (the `isAvailable` flag gates stream access).
4. Notify the uploader of the takedown by email within 24 hours (include counter-notification instructions).
5. Issue the strike to the artist via `strikeService.addStrike()`.

### 3.3 Counter-Notification

If an uploader believes the takedown was erroneous:

1. They submit a counter-notification including: identification of the removed content, statement under penalty of perjury that removal was a mistake, consent to federal court jurisdiction, and contact information.
2. Syra forwards the counter-notification to the original complainant within 2 business days.
3. If the complainant does not notify Syra of a court action within 10–14 business days, the content may be restored.

---

## 4. Repeat-Infringer Termination Policy

Syra implements a three-strikes repeat-infringer termination policy as required by § 512(i)(1)(A).

### 4.1 Strike Thresholds

| Strikes | Action |
|---------|--------|
| 1 | Warning issued; content removed |
| 2 | Second warning; uploads temporarily disabled |
| 3 | **Account permanently terminated** |

The threshold is defined as `STRIKE_TERMINATION_THRESHOLD = 3` in `packages/backend/src/services/strikeService.ts`.

### 4.2 Termination Mechanics

On the third strike, `addStrike()` in `strikeService.ts`:

1. Sets `artist.terminated = true`, `artist.terminatedAt`, and `artist.terminationReason`.
2. Sets `artist.uploadsDisabled = true`.
3. Calls `takeDownArtistTracks()` — bulk-updates ALL of the artist's tracks to `copyrightRemoved: true` with `removedReason: "Repeat-infringer termination"`.

Termination is **permanent and irreversible** via the strike-removal API. An admin removing individual strikes does not clear the `terminated` flag. Re-activation requires manual intervention by the compliance team.

### 4.3 `isRepeatInfringer()` Helper

```ts
// packages/backend/src/services/strikeService.ts
export function isRepeatInfringer(strikeCount: number): boolean {
  return strikeCount >= STRIKE_TERMINATION_THRESHOLD;
}
```

### 4.4 Upload Permission Gate

`checkUploadPermission(artistId)` returns `false` when `artist.terminated === true` OR `artist.uploadsDisabled === true`, preventing any new uploads from a terminated account.

---

## 5. EU Article 17 (Copyright Directive 2019/790)

Article 17 (formerly Article 13) imposes stricter obligations on "Online Content-Sharing Service Providers" (OCSSPs) that store and give the public access to large amounts of user-uploaded copyright-protected content.

### 5.1 Startup Exemption

Syra may qualify for the Article 17 startup exemption while it meets **all three** of the following conditions:

- Has been operating for **less than 3 years**; AND
- Has annual turnover **below €10 million**; AND
- Has **fewer than 5 million unique monthly visitors/users** in the EU.

Under the exemption, the obligation is limited to:
- Making best efforts to obtain authorizations from rightsholders.
- Acting expeditiously to take down infringing content upon notification.
- Preventing re-uploads of notified works where technically feasible.

**Action:** Track the startup exemption expiry date. When any threshold is exceeded, a full Article 17 compliance program (including upload filter / rights database) is required.

### 5.2 Best-Efforts Measures (Pre-Exemption Expiry)

- The ACRCloud fingerprint hook (`services/compliance/acrcloud.ts`) is the planned pre-publish screen. Once credentials are configured, `screenBeforePublish()` gates uploads against known commercial recordings.
- Maintain a list of takedown-notified content to prevent re-upload (`CopyrightReport` model with `trackId` + `fingerprintHash` when available).

---

## 6. Record-Keeping

Retain the following for a minimum of 3 years (or as required by applicable law):

- All DMCA takedown notices received and the corresponding `CopyrightReport` documents.
- All counter-notifications received.
- Timestamps of takedown and restoration actions (stored in `Track.removedAt`, `Artist.terminatedAt`).
- All strike records (`Artist.strikes[]`).

---

*This document is internal operational guidance. It is not legal advice. Review with qualified copyright counsel before public disclosure or service launch.*
