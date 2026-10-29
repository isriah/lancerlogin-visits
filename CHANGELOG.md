# Changelog

All notable changes to the LancerLogin Guest Visits plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

Add a `## [X.Y.Z] - YYYY-MM-DD` entry above older entries for each stable or beta release. An entry not released yet is dated `Unreleased` until its release commit.

## [0.2.0] - Unreleased

The guest page books from a five-week calendar that fills the window on desktop: choosing a highlighted day opens a card over it with the time slots, arrival and departure, and the booking form. Guests type only their team number; Team lookup finds the program and name in FIRST’s FRC and FTC team lists once an Admin saves FIRST Events API credentials. The guest’s note is now called Team needs. The guest page and the setup step no longer repeat the time zone. Adds migration 0002. See [v0.2.0](docs/releases/v0.2.0.md).

## [0.1.0] - 2026-10-28

The first release of Guest Visits: a public booking page for guest team visits, emailed links to change or cancel, a staff workspace for availability and visits, Discord messages with a weekly summary, a report dataset and an optional Outreach link. Requires a LancerLogin Core release with module SDK 1.1.0 (`lancerlogin.core` `>=2.0.0-beta.15 <3.0.0`). See [v0.1.0](docs/releases/v0.1.0.md).
