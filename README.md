# LancerLogin Guest Visits plugin

Guest Visits lets your team publish when guest teams may visit your shop, and lets those teams book a visit without an account. A guest team opens one page, chooses a highlighted day on a calendar of the next eight weeks, sees which teams are already coming that day, and books a time slot with an arrival and departure time and an email address. The confirmation email links to a page where that team can change or cancel its visit. Staff manage availability and visits in the dashboard, get a Discord message for each booking and a weekly Discord summary, report on visit history and, when Outreach is installed, record visits as Outreach Team Support.

This repository is a LancerLogin module plugin: module ID `visits`, table prefix `visits_`, module contract 1. It is opt-in. LancerLogin composes it into an installation's own build at an exact commit. See LancerLogin's `docs/MODULE-PLUGINS.md` for how plugins are selected, composed, updated and removed.

## Requirements

- **LancerLogin Core with module SDK 1.1.0.** Guest Visits uses Core's email service, the installation time zone, public sub-pages (`/visit/manage`) and cross-module calls, which arrive together in module SDK 1.1.0. Composition refuses the plugin on a Core without them. See [Compatibility](#compatibility).
- **Resend, enabled and verified** in **Settings > Integrations**. Every confirmation goes through Core's Resend connection and its From address; Guest Visits never holds Resend credentials. Setup cannot finish until a test email has been sent.
- **Discord (optional).** For booking messages and the weekly summary, connect the Discord bot in **Settings > Integrations**, then turn on Guest Visits messages and enter a channel ID in **Settings > Guest Visits**.
- **Outreach (optional).** To record visits as Outreach Team Support, the official Outreach plugin must be installed, enabled and set up, in a version that offers its team support interface (`hour-tracking.team-support` version 1). To record every booking automatically, an Admin grants Guest Visits access in **Settings > Modules > Module access**. Without a grant, staff who can use Outreach themselves can still record visits with **Record in Outreach**.

## Add Guest Visits to an installation

1. **Select the plugin.** In **Settings > Modules > Plugins**, choose **Add plugin**, enter module ID `visits`, source `https://github.com/isriah/lancerlogin-visits.git` and the commit of the release you reviewed, confirm, then **Apply plugin changes**. Or add the entry to `lancerlogin.modules.json` in the installation's private deployment repository and deploy:

   ```json
   {
     "format": 1,
     "modules": [
       { "id": "visits", "source": "https://github.com/isriah/lancerlogin-visits.git", "commit": "<full 40-character commit SHA>" }
     ]
   }
   ```

   Pins are always full commit SHAs; tags and branches are refused. From a Core checkout, `npm run plugins:resolve -- --selection path/to/lancerlogin.modules.json --track stable --module visits` writes the commit of the newest stable release. This repository is public, so no plugin token is needed.
2. **Enable it.** In **Settings > Modules**, turn on **Guest Visits**. Its database tables were created when the build was deployed; enabling creates the default settings (Discord messages off, weekly summary Monday 12:00).
3. **Finish guided setup.** Two required steps:
   - **Email confirmations:** send a test email through Core's Resend connection.
   - **First availability window:** add a repeating window (weekdays, start and end time, first and last date) or a one-off window.
4. **Fill in Settings > Guest Visits.** Your team's name (for example "FRC 321 Lancers", shown on the guest page and in guest emails; left empty, they say "our team"), the guest page intro, a reply-to address for guest emails, and optionally Discord messages and the weekly summary. Copy the guest page link from there and share it.
5. **Assign Operators (optional).** Admins always manage Guest Visits. Assign Guest Visits to Operators who should manage availability and visits. Settings stay Admin only.
6. **Grant Outreach access (optional).** In **Settings > Modules > Module access**, grant Guest Visits' request to create Outreach supported teams and Team Support activities.

## Guest pages

- **`/visit`**, no sign-in: a month calendar of the next eight weeks. Days with open times are highlighted (with their hours, or how many time slots, on wider screens) and are the days a guest can choose; a day whose windows were all canceled opens to show the reason, and other days are disabled. Choosing a day shows its time slots with their titles and the teams coming with their arrival and departure times. The guest picks a slot (a day with one slot picks it), then an arrival and departure inside it. A team books with its team number, team name, program (FRC, FTC, FIRST LEGO League Challenge, FIRST LEGO League Explore or Other), contact name and email, optional phone, arrival, departure, headcount and optional team needs (for example programming help, CAD review, machine shop access or practice field time). A known team number fills in the saved team name. The booking shows on the page at once. Phone first.
- **`/visit/manage#<link>`**, reached only from an email: the guest changes the date, times, headcount, team needs, contact name or phone, or cancels. Opening the link changes nothing; every change needs a button press, so an email scanner that opens links cannot cancel a visit. Team and email address are fixed there; staff can change them. Every change or cancellation, by the guest or by staff, emails the updated details with a fresh link.

## Staff workspace

**Guest Visits** in the dashboard (`/visits`), for Admins and assigned Operators:

- **Availability:** repeating and one-off windows that never overlap, edited one at a time or as a series, canceled with a reason and restored.
- **Visits:** Upcoming, Past and Removed lists. Edit, cancel or remove a visit, restore any earlier version from its history (removed visits too), and resend the confirmation with a fresh link. Correcting the email address stops every earlier link from working.
- **Needs attention:** visits whose window was canceled, removed or changed, emails that failed, wait under the daily cap or were stopped by a backup restore, Outreach records that failed, and visits recorded in Outreach before they were canceled or moved. Mark each handled after contacting the team.
- **Guest teams:** rename a team, merge a duplicate into another team of the same program, and see whether it is linked to an Outreach supported team.
- **Record in Outreach:** shown while Outreach can be used, for one visit or every visit in the list not recorded yet. Each visit shows whether it was recorded, waits, failed or was skipped. With an Admin's grant, bookings and date changes are recorded automatically within five minutes; a moved visit is recorded on its new date, and the earlier activity stays in Outreach, since members may have logged hours to it.
- **Reports:** the **Guest visits** dataset in Reports lists date, team, program, arrival, departure, duration, headcount, status and whether the visit is recorded in Outreach, filtered by period, with CSV export.

## Discord and the weekly summary

With Discord messages on, Guest Visits posts one message per booking, change and cancellation. The weekly summary is on by default and posts at a chosen weekday and time in the installation time zone (default Monday 12:00 PM). It lists every booked visit that has not ended by the report time and starts before the next report, grouped by day, and a week with no visits still posts "No guest visits scheduled this week". Each week posts once, even across retries; a missed time posts on the next pass, and a summary not sent before the following report time is skipped. Messages mention no one, carry no contact details or team needs, and cannot post twice when retried.

## Team lookup

When a guest enters a team number, Guest Visits looks it up in FIRST's FRC and FTC team lists (the current season, then the previous one) and in this installation's saved guest teams, so the guest page can fill in the program and team name. FIRST LEGO League teams, and programs without a credential, are entered by hand.

- **Credentials:** an Admin registers for FIRST's Events API ([FRC](https://frc-events.firstinspires.org/services/API), [FTC](https://ftc-events.firstinspires.org/services/API)) and enters each program's username and token in **Settings > Guest Visits > Team lookup**. Saving checks them with FIRST first. The token is encrypted with Core's credential service, stored only as ciphertext and never shown again; saving needs Core's credential encryption to be configured.
- **What FIRST receives:** the team number, with the installation's FIRST credential. Never guest names, contact details or anything else from a booking.
- **Caching and limits:** FIRST's answers, "no team" included, are kept for seven days, and each program's current season for a day. At most 30 requests go to FIRST per minute, each given up after 4 seconds; past the limit, or when FIRST fails, a lookup answers from the cache and saved teams only, and the guest can enter the team by hand.
- **Data:** credentials and cached answers are never in backups (an Admin saves the credentials again after a restore) and are deleted with the rest of Guest Visits data. Removing a credential also forgets that program's cached answers.

## Privacy and data

- **Public:** anyone with the guest page link sees team number, name, program, arrival, departure and headcount. Contact names, email addresses, phone numbers and team needs are visible to staff only, and never appear in Discord messages or the weekly summary.
- **Manage links** are sent only by email. Each is 32 random bytes in the URL fragment, which keeps it out of server logs and `Referer` headers; only its SHA-256 is stored. A link works only for its own visit and only until the visit ends. Correcting the email address revokes every earlier link.
- **Email cap:** each address gets at most ten Guest Visits emails per day. A booking over the cap still saves; its email waits until the next day and Needs attention shows it. Addresses are counted only as SHA-256 hashes, and counts are forgotten after a day.
- **Abuse protection** is limited to dashboard-origin checks, input validation, idempotent submission, the email cap and change history. Guests have no accounts.
- **Change history** records every change, who made it (the guest, or a staff user ID) and the visit after it.
- **Disabling** Guest Visits closes its pages and keeps its data for seven days, so enabling it again within that time brings everything back. After that, LancerLogin deletes all Guest Visits data: availability windows and series, guest teams, visits with contact details, team needs and change history, settings, queued emails, Discord messages and Outreach work, manage links and email counts, Guest Visits setup and Operator assignment records, and any Module access grant involving Guest Visits. Supported teams and Team Support activities already created in Outreach belong to Outreach and stay there.
- **Backups:** entire-installation backups carry Guest Visits' settings, availability, teams, visits, change history and notification records. They never contain manage links, guest submission keys or email counts, so a restore stops every earlier link. A restore also pauses queued emails, Discord messages and Outreach records, so nothing sends on its own; those visits appear in Needs attention, and staff resend confirmations so teams get working links. Module access grants are never restored: an Admin grants Outreach access again.

## Compatibility

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | `>=2.0.0-beta.15 <3.0.0` (Modular 2.0.0-beta.15, the first Core with module SDK 1.1.0, and later 2.x releases) | `^1.1.0` | 1 |

The supported Core range is the `lancerlogin.core` field in `package.json`, and the module SDK peer range declares the SDK features Guest Visits needs. Composition refuses the plugin for a Core outside that range or with an older SDK, before an installation build or web update starts. React and `@lancerlogin/module-sdk` are peer dependencies provided by Core. Recording in Outreach also needs an Outreach release with the `hour-tracking.team-support` interface.

## Repository layout

| Path | Purpose |
| --- | --- |
| `package.json` | Package name, version, `lancerlogin` plugin declaration (module ID, contract, supported Core range, table prefix, entries, migrations) and peer dependencies |
| `package-lock.json`, `.npmrc` | Lockfile. Peer dependencies are provided by Core and never installed here. The plugin has no runtime dependencies |
| `src/manifest.ts` | Module definition: navigation, settings, capability, setup steps, job, report dataset, Outreach use, API routes, tables, backup and cleanup declarations |
| `src/api.ts` | Worker contribution: connects Core's services, time zone and Outreach calls to the handlers in `src/api/` |
| `src/api/visits-*.ts` | Worker routes (guest, manage, workspace, settings, setup), notification delivery and the job, the report projection and the Outreach link |
| `src/dashboard.tsx` | Dashboard contribution: workspace, settings, guided setup and the public pages |
| `src/dashboard/visits-*.tsx`, `src/dashboard/visits-*.ts` | Guest page, manage page, workspace sections, settings and setup, with their plain form, label and time helpers |
| `src/shared/visits-api.ts` | The HTTP contract between the dashboard and the Worker routes |
| `src/shared/visits-*.ts` | Import-free rules shared by the Worker, the dashboard and the tests: time zones, availability, booking, tokens, email and Discord text, weekly summary, email cap, notification queue, Outreach answers, report fields and storage declarations |
| `src/visits.css` | Styles, each rule scoped to the Guest Visits module root |
| `migrations/` | `0001_create_visits_tables.sql`, `0002_create_visits_first_tables.sql` (team lookup credentials, caches and limit) and `reviewed.json` with their SHA-256 |
| `tests/` | `npm test`: unit, SQL and route tests, with an Intl stand-in for the SDK's civil-time helpers, a D1-shaped adapter over Node's built-in SQLite and synthetic email, Discord and Outreach in `tests/helpers/` |
| `scripts/verify-with-core.mjs` | Composes this commit into a Core checkout, then typechecks and builds it |
| `scripts/plugin-release.mjs`, `scripts/release-policy.mjs` | Release, nightly and version rules, the same as the official plugins |
| `.github/plugin-release.json` | Repository, release title and pinned Core |
| `CHANGELOG.md`, `docs/releases/` | Release summaries and the patch notes published with each release |

Times are stored as instants and entered in the installation time zone. On days when clocks change, a skipped local time becomes the moment the clock jumps to, and a repeated local time takes its earlier occurrence for starts and its later occurrence for ends (see `src/shared/visits-time.ts`).

## Development

Work needs Node 24 and, for anything beyond the unit tests, a LancerLogin Core checkout with module SDK 1.1.0 and `npm ci` done there.

- **`npm test`** runs without installed packages or Core: logic tests for every `src/shared` module (including daylight saving changes in America/New_York), SQL tests that apply the migration to an in-memory `node:sqlite` database (constraints, triggers, uniqueness, cascades, leases, cleanup order and a backup round trip), the Worker routes with synthetic email, Discord and Outreach and a controlled clock, the dashboard's form and label helpers, the package check that the manifest, `package.json`, the storage declarations and `migrations/reviewed.json` agree, a check that authored text uses no em or en dashes, and the release policy tests.
- **`npm run verify:core -- ../LancerLogin`** composes the committed plugin (commit first; it refuses a dirty tree) into a Core checkout with Core's official plugins, typechecks and builds the composed Worker and dashboard, then restores Core's generated files. Add `--mode fast` to compose and typecheck only.
- **`npm run plugins:dev -- --plugin ../lancerlogin-visits`**, run from the Core checkout, composes this folder with Core's official plugins and starts a local Worker and dashboard that recompose when a file changes. Use synthetic data and test credentials only. Stop it with Ctrl+C, or run `npm run plugins:dev -- --restore` to put Core's generated files back.

Files in `src/shared` import only each other, never the module SDK or `node:` built-ins, so `npm test` runs without Core. Time-zone code receives the SDK's civil-time helpers as an argument (`CivilTime` in `src/shared/visits-time.ts`); the Worker and dashboard pass `{ resolveCivilTime, instantToCivil }` from `@lancerlogin/module-sdk`.

Rules Core enforces when it composes the plugin: plugin code imports only `@lancerlogin/module-sdk`, React and its own files, never Core source; every table, index and trigger starts with `visits_`; API routes live under `/admin/visits`, `/public/visits` or `/module-setup/visits`; every table is either backed up or declared non-portable; released migrations are never edited, and a schema change is a new numbered migration listed in `reviewed.json`.

## Continuous integration

**Verify** (`.github/workflows/ci.yml`) runs on every push to `main`, every pull request and on demand. It runs `npm test`, checks out the LancerLogin Core commit pinned in `.github/plugin-release.json` from the public [isriah/LancerLogin](https://github.com/isriah/LancerLogin) repository, composes this plugin commit into it with Core's official plugins, and typechecks and builds the composed Worker and dashboard. The pin is currently Modular `v2.0.0-beta.15`, recorded by its full commit SHA with the tag beside it for people; it must name a published Core release inside the supported range (see [Compatibility](#compatibility)).

No repository secrets are needed. Two optional secrets are used only when set, for a Core pin that is private: `LANCERLOGIN_CORE_TOKEN` (Contents: read on that Core repository) and `LANCERLOGIN_PLUGIN_TOKEN` (read access to private plugin repositories that Core composes).

## Releasing

Releases follow LancerLogin's rules. The highest version wins, never the most recent publication.

| Track | Tags | Offered to | Use for |
| --- | --- | --- | --- |
| Stable | `vX.Y.Z` | Stable, Beta and Nightly | Production installations |
| Beta | `vX.Y.Z-beta.N`, GitHub prerelease | Beta and Nightly | Installations that opted in to early releases |
| Nightly | `vX.Y.Z-nightly.YYYYMMDD`, GitHub prerelease | Nightly only | **Test installations only** |

1. On `main`, set `package.json` `version`, add `docs/releases/vX.Y.Z.md` (title `# LancerLogin Guest Visits plugin vX.Y.Z`, a short summary, then **Bugs fixed**, **Features added** and **Features removed**, writing `None.` for an empty section) and a `## [X.Y.Z] - YYYY-MM-DD` entry in `CHANGELOG.md` (the release date replaces `Unreleased`). Commit them as `Release vX.Y.Z`.
2. Wait for **Verify** to pass for that exact commit on `main`.
3. Tag the commit and push the tag: `git tag vX.Y.Z <commit>` and `git push origin vX.Y.Z`.
4. **Release plugin** (`.github/workflows/release.yml`) checks the version, notes, changelog and release commit, requires the successful Verify run for that exact commit, and prepares a draft release with the patch notes.
5. Publish from a checkout of the repository with your GitHub CLI login: `node scripts/plugin-release.mjs publish vX.Y.Z` to check, then `node scripts/plugin-release.mjs publish vX.Y.Z --publish`.
6. Installations adopt the release by updating their pin, for example with `npm run plugins:resolve`.

**Nightly plugin build** (`.github/workflows/nightly.yml`) runs daily and on demand from `main`. It publishes `vX.Y.Z-nightly.YYYYMMDD` only when `main` has commits that are not in any release and Verify passed for that exact commit. Nightly builds never become Latest and are never offered to the Stable or Beta tracks.

Patch notes for each stable and beta release are in [docs/releases](docs/releases/README.md); [CHANGELOG.md](CHANGELOG.md) summarizes every release.

## License

Apache-2.0. See [LICENSE](LICENSE).
