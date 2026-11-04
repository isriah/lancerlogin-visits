# Changelog

All notable changes to the LancerLogin Guest Visits plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

Add a `## [X.Y.Z] - YYYY-MM-DD` entry above older entries for each stable or beta release. An entry not released yet is dated `Unreleased` until its release commit.

## [Unreleased]

The next release's version and date are set at its release commit. The workspace banner for failed messages is fixed: it no longer says failed messages are retried every five minutes (they are not), and it no longer counts failures forever. Each failed Discord post (a booking post or the weekly summary) gets its own banner that names it, says why it failed and where to fix it: the Discord permissions the bot lacks in the channel when Guest Visits can work them out from Discord (View Channel, Send Messages, or Send Messages in Threads), otherwise which ones to check; a channel Discord can't find, with a link to **Settings > Guest Visits > Discord**; or Discord's own words. Admins can **Retry** a post (a booking post until its visit ends, a weekly summary within a day of its report time) or **Dismiss** it, and changing the Discord channel or turning Discord messages on or off resolves earlier failed posts without posting them late. A refused post (missing permission or unknown channel) now fails at once instead of after eight attempts. Failed booking emails and Outreach records get their own banner pointing to Needs attention, and count only until staff handle them. Adds `POST /admin/visits/notifications/:id/dismiss` and `/retry` (Admin only) and `VisitsStatus.failures`. No migration: the reason is kept in `last_error`.

## [0.4.0] - 2026-11-02

Drops `visits_first_credentials`, where Guest Visits kept FRC and FTC credentials before team lookup moved to Settings > Integrations > FIRST (migration 0005). Guest Visits 0.3.0 moved them into Core at run time, so **install v0.3.0 first**: an installation on 0.2.x must update to 0.3.0 and let it run before updating to this release, or the credentials would be dropped before they move. `package.json` declares `lancerlogin.upgradeRequiresMigrations: ["0004_drop_first_caches.sql"]`, so Core refuses the upgrade until 0.3.0's migration has run; new installations install this release directly. Requires LancerLogin Core 2.1.0-beta.4 or later (`lancerlogin.core` `>=2.1.0-beta.4 <3.0.0`), the first Core with `upgradeRequiresMigrations`; older Cores refuse the key at composition. A credential 0.3.0 could not move (Core could not read it) is dropped and must be saved again in Settings > Integrations > FIRST; Team lookup settings no longer warn about one. The code that moved credentials into Core is removed, and the credentials' cleanup step is retired in place. Backups never contained the table, so the backup version stays 2. See [v0.4.0](docs/releases/v0.4.0.md).

## [0.3.0] - 2026-11-01

Team lookup runs on LancerLogin's shared FIRST connection (`services.first`): FRC and FTC credentials are saved in **Settings > Integrations > FIRST**, and those saved in Guest Visits move there on their own the first time the new release runs. Team lookup also finds FLL Challenge and FLL Explore teams, with no credential, and those programs read **FLL Challenge** and **FLL Explore**. The booking form's **Headcount (approximate)** is required, and the Worker refuses a new booking without one; visits saved without one keep reading "Not given", and the **Require headcount** setting is gone. The guest calendar opens on this week rather than last week, and the guest page heading always reads **Book a team visit**. **Settings > Guest Visits > Team lookup** now shows which programs lookup works for and links to Settings > Integrations. Requires a Core with module SDK 1.2.0 (`lancerlogin.core` `>=2.1.0-beta.3 <3.0.0`, `@lancerlogin/module-sdk` `^1.2.0`). Adds migration 0004, which drops Guest Visits' FIRST caches. See [v0.3.0](docs/releases/v0.3.0.md).

## [0.2.1] - 2026-10-29

Staff can add availability from the day picked on the calendar (double-click, Enter, or select then Add availability), Repeats and Weekdays use a switch and a single row of day buttons, and switching Repeats keeps the entered date. Guest bookings default to the whole open window, and headcount is optional unless an Admin turns on Require headcount. Adds migration 0003 and Guest Visits backup version 2. See [v0.2.1](docs/releases/v0.2.1.md).

## [0.2.0] - 2026-10-29

The guest page books from a five-week calendar that fills the window on desktop: choosing a highlighted day opens a card over it with the time slots, arrival and departure, and the booking form. Guests type only their team number; Team lookup finds the program and name in FIRST’s FRC and FTC team lists once an Admin saves FIRST Events API credentials. The guest’s note is now called Team needs. The guest page and the setup step no longer repeat the time zone. Adds migration 0002. See [v0.2.0](docs/releases/v0.2.0.md).

## [0.1.0] - 2026-10-28

The first release of Guest Visits: a public booking page for guest team visits, emailed links to change or cancel, a staff workspace for availability and visits, Discord messages with a weekly summary, a report dataset and an optional Outreach link. Requires a LancerLogin Core release with module SDK 1.1.0 (`lancerlogin.core` `>=2.0.0-beta.15 <3.0.0`). See [v0.1.0](docs/releases/v0.1.0.md).
