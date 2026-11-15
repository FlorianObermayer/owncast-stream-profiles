# Contributing

Issues and pull requests are welcome. This file is the whole developer guide — if
something is missing, that is a bug.

## Setup

```bash
npm ci          # @owncast/plugin-sdk plus its test/dev host binaries
npm test        # build, then run the scenario suite
npm run serve   # dev server on localhost:8080
npm run release:verify   # what CI runs; must pass before a PR
```

No Owncast server is needed: the SDK bundles the host runtime the tests drive the
plugin through. `npm ci` downloads that binary from the `owncast/plugin-sdk`
releases; `OWNCAST_PLUGIN_HOST_BINARIES_VERSION` pins the tag and is already set
in CI.

## Layout

| Path | What it is |
| --- | --- |
| `src/plugin.js` | Field schema, admin API calls, HTTP routes |
| `public/admin/` | The admin page: three static files, no build step |
| `plugin.manifest.json` | Identity, permissions, config shown to admins |
| `INSTRUCTIONS.md` | Admin-facing guide, bundled into the package |
| `assets/defaults/logo.png` | Owncast's stock logo, used to reset branding |
| `icon.png` / `icon.svg` | Plugin badge |
| `__tests__/` | Scenario tests |
| `scripts/check-release.mjs` | Release and security guard |
| `scripts/set-version.mjs` | Bumps the version in all three files at once |
| `.github/images/` | Screenshots for the README |

## Adding a field

The schema is duplicated on purpose: the plugin needs it to coerce values and call
the API, the page needs it to render widgets. Both sides change together.

1. `FIELD_SPECS` in `src/plugin.js` — `key`, `label`, `path`, `type`, and a
   `capture` reader for `GET /api/admin/serverconfig`.
2. `FIELD_DEFS` in `public/admin/admin.js` — `label`, widget `type`, `group`,
   `hint`. The hint is the only explanation a user gets, so write it.
3. `DEFAULT_SKIPPED` in both files if new profiles should not apply it.
4. `activation` in both files if Owncast reads the value later than it is written.
5. A scenario in `__tests__/profiles.test.json`.

Widget types: `text`, `textarea`, `list`, `boolean`, `enum`, `actions`, `socials`,
`image`.

## Testing

`npm test` runs every scenario through the real host runtime. Outbound HTTP, KV
writes and HTTP responses are captured for assertions; nothing needs a server.

Three details cause most of the friction:

* `expect.kv` is **partial** — only the keys you list are checked.
* `expect.httpRequests` is an **exact ordered list**, so adding a field means
  updating any scenario that applies it.
* An outbound call with no matching `given.httpResponses` fixture fails the
  scenario, by design.

Two details specific to this plugin:

* Set **`authenticated: true`** on `/admin/api/*` steps, or the host answers 401
  before our code runs. Omit it to assert that gate.
* The **admin password goes in the request body**, never `given.config`: pass
  `{"password": "..."}` on apply and server calls.

`npm run serve` (`PORT=8765` to change) adds dev-only endpoints for handlers HTTP
cannot reach: `POST /_dev/chat`, `GET /_dev/chat`, `POST /_dev/event`. Restart it
after code changes; use scenarios for repeatable assertions.

`npm run package` runs `owncast-plugin-test --load-only` first — the same
install-time path a server uses — so a package cannot be built from a plugin that
would fail to load.

## Releasing

The version is recorded in three places, and all three must agree before a tag:
`package.json`, `package-lock.json` and `plugin.manifest.json`. Use the script;
`npm version` alone only updates the first two, and the manifest is the one the
host and the catalog read.

```bash
npm run version:bump patch   # or minor / major / 0.1.0
npm run release:verify
git commit -am "release 0.0.2" && git tag v0.0.2 && git push origin main --tags
```

`scripts/check-release.mjs` refuses the run when the versions disagree, the tag
does not match, the permission set changed, an action is not pinned to a commit
SHA, or the package contains an unexpected file. Run it alone for the fast
version; failures name the rule.

The tag runs `.github/workflows/release.yml`: verify, test, build, checksum,
attest provenance, then create the GitHub release with `stream-profiles.ocpkg`
and `SHA256SUMS.txt`. Permissions are granted per job and no personal access
token is involved.

```bash
sha256sum -c SHA256SUMS.txt
gh attestation verify stream-profiles.ocpkg \
  --repo FlorianObermayer/owncast-stream-profiles
```

Adding a **permission** is user-visible: every installed copy shows "needs
re-approval" until an admin approves. Update `EXPECTED_PERMISSIONS` in
`scripts/check-release.mjs` in the same commit.

## Publishing to the catalog

Optional, and manual. Every Owncast install's **Browse** tab reads
`owncast.directory/api/plugins` by default, so a listing is what gives admins
one-click install and updates. Without it they upload the `.ocpkg` by hand.

Sign in at <https://owncast.directory/plugins/submit> with a magic link, upload
the `.ocpkg`, and fill in the optional metadata: preview image, category
(`admin-utilities` for us), tags, summary, homepage, source URL, license.

* The first submitter owns the slug, bound to their account.
* Each version is published once: bump the manifest version per upload.
* There is no CLI or token, so this cannot run in CI.

A private registry is also possible: set `OWNCAST_PLUGIN_REGISTRY` to any base URL
serving `GET /plugins` and `GET /plugins/<slug>` with
`{slug, homepage, versions: [{version, sha256, downloadURL}]}`.

## Conventions

* Plain ES2020. The plugin runs in a sandboxed interpreter, not Node: no `fetch`,
  no `btoa`, no filesystem, no `require` beyond the SDK. Use `owncast.*`.
* The admin page has no build step on purpose. Keep it three static files.
* Comments explain *why*. Restating the code is noise.
* No new runtime dependency without a reason: each is a supply-chain surface.

## Documentation direction

`INSTRUCTIONS.md` is the single source for admin-facing content, because it is the
copy rendered inside Owncast. `README.md` points at it - never the reverse.

It cannot link elsewhere instead: the Instructions tab is rendered inline in the
admin page, so a relative link 404s and an absolute one navigates the admin away.
`scripts/check-release.mjs` enforces absolute links there.
