# LancerLogin Guest Visits plugin

Guest Visits lets a team publish when guest teams may visit the shop and lets those teams book. A guest team opens one page, sees the open times for the next eight weeks and which teams are already coming, and books a visit with an arrival and departure time and an email address. The confirmation email links to a page where that team can change or cancel the visit. Staff manage availability and visits in the dashboard, get a Discord message for each booking and a weekly Discord summary of upcoming visits, report on visit history and, when Outreach is installed and an Admin allows it, record visits as Outreach Team support.

This repository is a LancerLogin module plugin (module ID `visits`, table prefix `visits_`). It is opt-in: an installation adds it in **Settings > Modules > Plugins** or in `lancerlogin.modules.json`. See LancerLogin's `docs/MODULE-PLUGINS.md` for how plugins are selected, composed, updated and removed, and `docs/PLUGIN-AUTHORING.md` for how they are written.

## Status

The domain rules, schema and tests are in place: availability series and windows, booking validation and fit, manage-link tokens, guest emails and Discord text, the weekly summary schedule, the per-address email cap, the notification queue, backup and cleanup. The guest page (`/visit`), manage page (`/visit/manage`), staff workspace (`/visits`), settings (`/settings/visits`), notification job and report need LancerLogin Core's email service, installation time zone, public sub-pages and cross-plugin calls, and arrive once that Core release is available. Until then the Worker routes and dashboard pages are placeholders.

## What it does

- **Guest page** at `/visit`, no sign-in: open windows for the next eight weeks with their titles, the teams coming and their arrival and departure times, and canceled windows with their reason. Booking takes team number, team name, program (FRC, FTC, FIRST LEGO League Challenge, FIRST LEGO League Explore or Other), contact name, contact email, optional phone, arrival, departure, headcount and an optional note. Anyone with the page URL sees team number, name, program, times and headcount; contact details and notes are for staff only.
- **Manage page** at `/visit/manage#<token>`, reached only from the confirmation email: change the date, times, headcount, note, contact name and phone, or cancel. Opening the link changes nothing. Every change sends an update email with a fresh link. Each link works until the visit ends; staff correcting the email address revokes the earlier links.
- **Staff workspace** at `/visits` for Admins and assigned Operators (capability `visits.manage`): repeating and one-off availability windows that never overlap, cancel and restore with a reason, edit or remove visits and restore earlier versions from history, resend confirmations, Needs attention, and guest teams.
- **Notifications**: emails through Core's email service with at most ten Guest Visits emails per address per day, Discord messages for bookings, changes and cancellations, and a weekly summary (default Monday 12:00 in the installation time zone).
- **Outreach link** (optional): once an Admin grants Guest Visits access to Outreach, each booked visit is recorded as Outreach Team support on its date.

Times are stored as instants and entered in the installation time zone. On days when clocks change, a skipped local time becomes the moment the clock jumps to, and a repeated local time takes its earlier occurrence for starts and its later occurrence for ends (see `src/shared/visits-time.ts`).

## Compatibility

| Plugin | LancerLogin Core | Module contract |
| --- | --- | --- |
| 0.1.x | To be set to the first Core release with the email service, installation time zone, public sub-pages and cross-plugin calls (module SDK 1.1.0) | 1 |

The supported Core range is the `lancerlogin.core` field in `package.json`. Composition refuses the plugin for a Core outside that range, before an installation build or web update starts. React and `@lancerlogin/module-sdk` are peer dependencies provided by Core.

## Layout

| Path | Purpose |
| --- | --- |
| `package.json` | Package name, version, `lancerlogin` plugin declaration (module ID, contract, supported Core range, table prefix, entries, migrations) and peer dependencies |
| `package-lock.json`, `.npmrc` | Lockfile. Peer dependencies are provided by Core and never installed here. The plugin has no runtime dependencies |
| `src/manifest.ts` | Module definition: navigation, settings, capability, API routes, tables, backup and cleanup declarations |
| `src/api.ts` | Worker contribution: route handlers, setup, cleanup, first-enable defaults and backup |
| `src/dashboard.tsx` | Dashboard contribution: workspace and settings pages |
| `src/shared/visits-time.ts` | Civil-time adapter type, local dates and times, the daylight saving policy and plain formatting |
| `src/shared/visits-schedule.ts` | Repeating series, one-off windows, overlap and which windows a series edit replaces |
| `src/shared/visits-booking.ts` | Booking and manage-page validation, window fit, the public projection, change history and Needs attention |
| `src/shared/visits-tokens.ts` | Manage-link tokens: generation, hashing, links and acceptance |
| `src/shared/visits-text.ts` | HTML and Discord escaping, guest emails and Discord messages |
| `src/shared/visits-summary.ts` | Weekly summary timing, selection and formatting |
| `src/shared/visits-limits.ts` | Per-address daily email cap |
| `src/shared/visits-notifications.ts` | Notification queue: kinds, retries, leases and Discord nonces |
| `src/shared/visits-storage.ts` | Portable and non-portable tables, backup columns, cleanup steps and restore handling |
| `migrations/` | `0001_create_visits_tables.sql` and `reviewed.json` with its SHA-256 |
| `tests/` | Unit and SQL tests (`npm test`), with an Intl stand-in for the SDK's civil-time helpers and a D1-shaped adapter over Node's built-in SQLite in `tests/helpers/` |
| `scripts/verify-with-core.mjs` | Composes this commit into a Core checkout, then typechecks and builds it |
| `scripts/plugin-release.mjs`, `scripts/release-policy.mjs` | Release, nightly and version rules, the same as the official plugins |
| `.github/plugin-release.json` | Repository, release title and pinned Core |

Files in `src/shared` import only each other, never the module SDK or `node:` built-ins, so `npm test` runs without a Core checkout. Time-zone code receives the SDK's civil-time helpers as an argument (`CivilTime` in `src/shared/visits-time.ts`); the Worker and dashboard pass `{ resolveCivilTime, instantToCivil }` from `@lancerlogin/module-sdk`.

Rules Core enforces when it composes the plugin: plugin code imports only `@lancerlogin/module-sdk`, React and its own declared dependencies, never Core source; every table, index and trigger starts with the table prefix; API routes live under `/admin/visits`, `/public/visits` or `/module-setup/visits`; every table is either backed up or declared non-portable; migrations are never edited once released.

## Tests

`npm test` runs on Node 24 with no installed packages:

- logic tests for every `src/shared` module, including daylight saving transitions in America/New_York on 2026-03-08 and 2026-11-01;
- SQL tests that apply the migrations to an in-memory `node:sqlite` database through a small D1-shaped adapter: constraints, overlap and revision triggers, uniqueness, cascades, the email cap, notification leases, cleanup order, a backup round trip and the indexes the Worker's queries use;
- the package check that the manifest, `package.json`, the storage declarations and `migrations/reviewed.json` agree, and the release policy tests.

## Continuous integration

**Verify** (`.github/workflows/ci.yml`) runs on every push to `main`, every pull request and on demand. It runs the unit tests, checks out the LancerLogin Core commit pinned in `.github/plugin-release.json` from the public [isriah/LancerLogin](https://github.com/isriah/LancerLogin) repository, composes this plugin commit into it with Core's official plugins and typechecks and builds the composed Worker and dashboard. Once the routes and pages use Core's email service, time zone, public sub-pages and cross-plugin calls, Verify passes only against a pinned Core release that includes them.

No repository secrets are needed. Two optional secrets are used only when set, for a Core pin that is private: `LANCERLOGIN_CORE_TOKEN` (Contents: read on that Core repository) and `LANCERLOGIN_PLUGIN_TOKEN` (read access to private plugin repositories that Core composes).

Run the same checks locally from a clean commit with a Core checkout beside it at the pinned commit (`npm ci` done there): `npm test`, then `npm run verify:core -- ../LancerLogin` (add `--mode fast` to compose and typecheck only). Verification restores Core's generated files afterwards, so the Core checkout stays clean.

## Releasing

Releases follow LancerLogin's rules. The highest version wins, never the most recent publication.

| Track | Tags | Offered to | Use for |
| --- | --- | --- | --- |
| Stable | `vX.Y.Z` | Stable, Beta and Nightly | Production installations |
| Beta | `vX.Y.Z-beta.N`, GitHub prerelease | Beta and Nightly | Installations that opted in to early releases |
| Nightly | `vX.Y.Z-nightly.YYYYMMDD`, GitHub prerelease | Nightly only | **Test installations only** |

1. On `main`, set `package.json` `version`, add `docs/releases/vX.Y.Z.md` (title `# LancerLogin Guest Visits plugin vX.Y.Z`, a short summary, then **Bugs fixed**, **Features added** and **Features removed**, writing `None.` for an empty section) and a `## [X.Y.Z] - YYYY-MM-DD` entry in `CHANGELOG.md`. Commit them as `Release vX.Y.Z`.
2. Wait for **Verify** to pass for that exact commit on `main`.
3. Tag the commit and push the tag: `git tag vX.Y.Z <commit>` and `git push origin vX.Y.Z`.
4. **Release plugin** (`.github/workflows/release.yml`) checks the version, notes, changelog and release commit, requires the successful Verify run for that exact commit, and prepares a draft release with the patch notes.
5. Publish from a checkout of the repository with your GitHub CLI login: `node scripts/plugin-release.mjs publish vX.Y.Z` to check, then `node scripts/plugin-release.mjs publish vX.Y.Z --publish`.
6. Installations adopt the release by updating their pin, for example with `npm run plugins:resolve`.

**Nightly plugin build** (`.github/workflows/nightly.yml`) runs daily and on demand from `main`. It publishes `vX.Y.Z-nightly.YYYYMMDD` only when `main` has commits that are not in any release and Verify passed for that exact commit. Nightly builds never become Latest and are never offered to the Stable or Beta tracks.

## License

Apache-2.0. See [LICENSE](LICENSE).
