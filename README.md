# LancerLogin plugin template

A minimal, working LancerLogin module plugin to start from. It adds an **Example Module** (module ID `example-module`) with:

- a workspace page at `/example-module` with its own navigation entry, listing notes and adding new ones;
- a settings page at `/settings/example-module`;
- one API route family, `/admin/example-module` (`GET` and `POST /admin/example-module/notes`);
- one forward-only migration that creates the `example_module_notes` table;
- a backup contribution, so notes are included in portable backups, and cleanup steps for retained-data deletion;
- unit tests, a Verify workflow that composes the plugin into LancerLogin Core and typechecks and builds it, and the release and nightly workflows the official plugins use.

LancerLogin composes a plugin into an installation's own build at an exact commit. For how to write plugins, see `docs/PLUGIN-AUTHORING.md` in isriah/LancerLogin (available from the next Modular release), and `docs/MODULE-PLUGINS.md` there for how plugins are selected, composed, updated and removed. The official plugins, [isriah/lancerlogin-outreach](https://github.com/isriah/lancerlogin-outreach) and [isriah/lancerlogin-carpool](https://github.com/isriah/lancerlogin-carpool), are larger examples of the same structure.

## Use this template

1. **Create your repository.** Choose **Use this template** on GitHub, or run `gh repo create <owner>/<repository> --template isriah/lancerlogin-plugin-template --private --clone`.
2. **Rename the module.** Pick a module ID (lowercase letters, digits and hyphens, for example `field-trips`) and a table prefix derived from it (`field_trips_`). Replace, everywhere in the repository:
   - `example-module` with your module ID, in `package.json` (`lancerlogin.moduleId` and `name`), `src/manifest.ts`, `src/api.ts`, `src/dashboard.tsx` and the route, navigation and settings paths;
   - `example_module_` with your table prefix, in `package.json` (`lancerlogin.tablePrefix`), `src/manifest.ts`, `src/notes.ts`, `src/api.ts` and the migration;
   - `Example Module` with your module's title, in `src/manifest.ts`, `src/dashboard.tsx` and the package description.
   Rename the migration file if you like, then update `migrations/reviewed.json` with its name and SHA-256 (`sha256sum migrations/0001_*.sql`; Core hashes the text with CRLF converted to LF). `npm test` checks that these agree.
3. **Update `.github/plugin-release.json`.** Set `repository` to your repository (`<owner>/<repository>`) and `title` to your plugin's name, for example `Field Trips plugin`. Release notes must start with that title. Keep `core` pinned to a LancerLogin release: a full commit SHA in `commit` and the release tag in `tag`.
4. **Run CI.** Push to `main`. **Verify** runs the unit tests, composes the plugin into the pinned Core with Core's official plugins, as an installation build would, and typechecks and builds the result. Fix anything it reports before you release.
5. **Cut an immutable release.** Enable immutable releases in **Settings > General > Releases**, then follow [Releasing](#releasing). Installations only accept immutable releases.
6. **Add the plugin to an installation.** In the installation's private deployment repository, add an entry to `lancerlogin.modules.json` with the full commit SHA of your release:

   ```json
   {
     "format": 1,
     "modules": [
       { "id": "example-module", "source": "https://github.com/<owner>/<repository>.git", "commit": "<full 40-character commit SHA>" }
     ]
   }
   ```

   Pins are always full commit SHAs; tags and branches are refused. From a LancerLogin Core checkout, `npm run plugins:resolve -- --selection path/to/lancerlogin.modules.json --track stable --module example-module` writes the commit of the newest stable release into the selection. A private plugin repository also needs `LANCERLOGIN_PLUGIN_TOKEN` in the deployment repository, with read access to the plugin repository. The next installation build or web update composes the plugin, and an Administrator then enables it.

## Layout

| Path | Purpose |
| --- | --- |
| `package.json` | Package name, version, `lancerlogin` plugin declaration (module ID, contract, supported Core range, table prefix, entries, migrations) and peer dependencies |
| `package-lock.json`, `.npmrc` | Lockfile. Peer dependencies are provided by Core and never installed here. If the plugin gains runtime `dependencies`, Core installs them from this lockfile with install scripts disabled |
| `src/manifest.ts` | Module definition: navigation, settings, capabilities, API routes, tables, backup and cleanup declarations |
| `src/api.ts` | Worker contribution: route handlers, setup, cleanup and backup |
| `src/dashboard.tsx` | Dashboard contribution: workspace and settings pages |
| `src/notes.ts` | Note rules and queries, shared by the API and the unit tests |
| `migrations/` | Forward-only SQL migrations numbered from `0001`, and `reviewed.json` with each file's SHA-256 |
| `tests/` | Unit tests (`npm test`) |
| `scripts/verify-with-core.mjs` | Composes this commit into a Core checkout, then typechecks and builds it |
| `scripts/plugin-release.mjs`, `scripts/release-policy.mjs` | Release, nightly and version rules, the same as the official plugins |
| `.github/plugin-release.json` | Repository, release title and pinned Core |

Rules Core enforces when it composes the plugin: plugin code imports only `@lancerlogin/module-sdk`, React and its own declared dependencies, never Core source; every table, index and trigger starts with the table prefix; API routes live under `/admin/<module ID>`, `/public/<module ID>` or `/module-setup/<module ID>`; every table is either backed up or declared non-portable; migrations are never edited once released.

## Compatibility

| Plugin | LancerLogin Core | Module contract |
| --- | --- | --- |
| 0.1.x | `>=2.0.0-beta.12 <3.0.0` (Modular 2.0.0-beta.12 and later 2.x releases) | 1 |

The supported Core range is the `lancerlogin.core` field in `package.json`. Composition refuses the plugin for a Core outside that range, before an installation build or web update starts. React and `@lancerlogin/module-sdk` are peer dependencies provided by Core.

## Continuous integration

**Verify** (`.github/workflows/ci.yml`) runs on every push to `main`, every pull request and on demand. It runs the unit tests, checks out the LancerLogin Core commit pinned in `.github/plugin-release.json` from the public [isriah/LancerLogin](https://github.com/isriah/LancerLogin) repository (currently Modular `v2.0.0-beta.12`, pinned by its full commit SHA; the tag is recorded beside it for people), composes this plugin commit into it with Core's official plugins and typechecks and builds the composed Worker and dashboard.

No repository secrets are needed. Two optional secrets are used only when set, for a Core pin that is private: `LANCERLOGIN_CORE_TOKEN` (Contents: read on that Core repository) and `LANCERLOGIN_PLUGIN_TOKEN` (read access to private plugin repositories that Core composes).

To test against a newer Core release, update `core.commit` (the full commit SHA of the release tag) and `core.tag` in `.github/plugin-release.json` in its own pull request.

Run the same checks locally from a clean commit with a Core checkout beside it:

```sh
git clone https://github.com/isriah/LancerLogin.git ../LancerLogin
git -C ../LancerLogin checkout f0b98331f7b0c3f1bce9033e42bbd62d3f8ca9d9
(cd ../LancerLogin && npm ci)
npm test
npm run verify:core -- ../LancerLogin              # compose, typecheck and build
npm run verify:core -- ../LancerLogin --mode fast  # compose and typecheck only
```

Verification restores Core's generated files afterwards, so the Core checkout stays clean.

## Releasing

Releases follow LancerLogin's rules. The highest version wins, never the most recent publication.

| Track | Tags | Offered to | Use for |
| --- | --- | --- | --- |
| Stable | `vX.Y.Z` | Stable, Beta and Nightly | Production installations |
| Beta | `vX.Y.Z-beta.N`, GitHub prerelease | Beta and Nightly | Installations that opted in to early releases |
| Nightly | `vX.Y.Z-nightly.YYYYMMDD`, GitHub prerelease | Nightly only | **Test installations only** |

1. On `main`, set `package.json` `version`, add `docs/releases/vX.Y.Z.md` (title `# <title from plugin-release.json> vX.Y.Z`, a short summary, then **Bugs fixed**, **Features added** and **Features removed**, writing `None.` for an empty section) and a `## [X.Y.Z] - YYYY-MM-DD` entry in `CHANGELOG.md`. Commit them as `Release vX.Y.Z`.
2. Wait for **Verify** to pass for that exact commit on `main`.
3. Tag the commit and push the tag: `git tag vX.Y.Z <commit>` and `git push origin vX.Y.Z`.
4. **Release plugin** (`.github/workflows/release.yml`) checks the version, notes, changelog and release commit, requires the successful Verify run for that exact commit, and prepares a draft release with the patch notes.
5. Publish from a checkout of the repository with your GitHub CLI login: `node scripts/plugin-release.mjs publish vX.Y.Z` to check, then `node scripts/plugin-release.mjs publish vX.Y.Z --publish`. Publication requires immutable releases, rechecks the tag, commit, Verify run and notes, publishes beta releases as prereleases, and makes a stable release Latest only when it is higher than the current Latest.
6. Installations adopt the release by updating their pin, for example with `npm run plugins:resolve`.

**Nightly plugin build** (`.github/workflows/nightly.yml`) runs daily and on demand from `main`. It publishes `vX.Y.Z-nightly.YYYYMMDD` only when `main` has commits that are not in any release and Verify passed for that exact commit. Nightly builds never become Latest and are never offered to the Stable or Beta tracks. The release and nightly workflows do nothing in the template repository itself; they run in repositories created from it.

## License

Apache-2.0. See [LICENSE](LICENSE). Add your own copyright notice when you publish your plugin.
