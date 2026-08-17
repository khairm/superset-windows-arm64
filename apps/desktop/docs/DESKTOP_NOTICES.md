# Desktop notices (server-driven announcements)

Show a popup in the desktop app **without shipping a release**. Rows in the `desktop_notices` table are served by `GET /api/desktop/version` and rendered by `DesktopNoticesGate`. The app polls every 30 minutes and on window focus; API failures fail open (no notice).

> **Fork override `(NO-REMOTE-UPDATE-GATE)`** — in this Windows ARM64 fork nothing this API returns can render a surface the user cannot close. `filterApplicableNotices` (packages/shared/src/desktop-notices.ts) rewrites every notice to at most `warning` and always `dismissible`, before the dismissal check, so dismissing one is permanent, and `forkVisibleNotices` is the renderer's only way in — it reads `notices` only, so the legacy `minimumVersion`/`message` pair produces no notice and no version comparison at all. The full-screen `UpdateRequiredPage` is deleted from the fork, and the dialog honours only `open-url` CTAs. So every row below renders as one dismissible dialog, and nothing a server sends can block the app or offer to install upstream's build over this one. See FEATURES.md.

## Authoring model

A notice is **one markdown body** plus behavioral fields. There is no title field — put the title in the markdown (`### Heads up: …`).

- Markdown supports headings, bold, links, lists, and images. Raw HTML is stripped.
- A leading image (`![alt](https://…)`) renders edge-to-edge at the top of the dialog, card-cover style (capped height, `object-cover`). Host images at any public URL (e.g. Vercel Blob).

## Creating one

Insert with `active = false`, verify, then flip `active = true` to ship (and back to `false` to pull — no deploy either way):

```sql
INSERT INTO desktop_notices
  (severity, "trigger", max_version, body, cta_label, cta_action, dismissible, active)
VALUES (
  'warning',
  'immediate',
  '1.99.0',
  E'### Heads up: v2.0 has breaking changes\n\nCloud mirrors need re-linking once after you update. [Details](https://superset.sh/changelog)',
  'Update now',
  'install-update',
  true,
  false
);
```

### Field reference

| Field | Values | Behavior |
| --- | --- | --- |
| `severity` | `info` \| `warning` \| `blocking` | Soft severities show the dialog (highest applicable wins). `blocking` is rewritten to `warning` in this fork — see the note at the top. |
| `trigger` | `immediate` \| `pre-update` \| `post-update` | `immediate`: dialog on boot/poll. `pre-update`: confirmation popover when the user clicks the update pill. `post-update`: release announcement, shown only to installs that updated into the release (see below). |
| `min_version` / `max_version` | semver or `NULL` | Bounds on the running app version; `NULL` = unbounded. For `post-update`, `min_version` is the announced version — shown only when the previous version was below it (fresh installs never see it). |
| `platforms` | e.g. `'{darwin}'` or `NULL` | Electron `process.platform` values; `NULL` = all. |
| `channels` | `'{stable}'` \| `'{canary}'` \| `NULL` | Canary = prerelease app versions; `NULL` = all. |
| `starts_at` / `ends_at` | timestamptz or `NULL` | Scheduling window. |
| `cta_label` + `cta_action` (+ `cta_url`) | `install-update` \| `open-url` | Optional button next to Dismiss. `open-url` needs `cta_url`. In this fork an `install-update` CTA renders no button (it would install upstream's build). |
| `dismissible` | boolean | Adds a Dismiss button (Esc/outside-click also dismiss). Dismissals persist per install, keyed by row id — a new row shows again. In this fork `false` is ignored: every notice is dismissible. |
| `active` | boolean | Kill switch; defaults to `false`. |

## QA

- **UI only**: dev command palette → `Preview notice: info / warning / blocking / post-update / pre-update` and `Clear notice preview`. A preview reaches the same guarded dialog surface, so the `blocking` preview renders as the dismissible dialog a served `blocking` notice produces. Esc also clears a preview.
- **DB → API → client**: with the local stack running, `NODE_ENV=development bun run packages/db/src/seed-desktop-notices.ts`, then check the dialog and `GET /api/desktop/version`.

## Production

Writing to the production `desktop_notices` table is a deliberate ops action — the root AGENTS.md database rules apply (never touch prod without explicit confirmation). Insert with `active = false`, verify the JSON at `https://api.superset.sh/api/desktop/version`, then flip `active`.
