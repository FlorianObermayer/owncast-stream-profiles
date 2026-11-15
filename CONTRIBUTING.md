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
| `src/auth.js` | Base64 and hand-written SHA-256, password hashing, credential records |
| `public/admin/` | The admin page: three static files, no build step |
| `plugin.manifest.json` | Identity, permissions, config shown to admins |
| `INSTRUCTIONS.md` | Admin-facing guide, bundled into the package |
| `assets/defaults/logo.png` | Owncast's stock logo, used to reset branding |
| `icon.png` / `icon.svg` | Plugin badge |
| `__tests__/` | Scenario tests |
| `scripts/check-release.mjs` | Release and security guard |
| `scripts/set-version.mjs` | Bumps the version in all three files at once |
| `.github/actions/verify/action.yml` | Test and package steps, shared by CI and the release |
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
* Gateway scenarios seed credentials under `auth:<profileId>` in `given.kv`. The
  stored hash depends on `ROUNDS` in `src/auth.js`, so changing it means
  regenerating those fixtures — the failure looks like "wrong password", not
  like a hashing change.

`npm run serve` (`PORT=8765` to change) adds dev-only endpoints for handlers HTTP
cannot reach: `POST /_dev/chat`, `GET /_dev/chat`, `POST /_dev/event`. Restart it
after code changes; use scenarios for repeatable assertions.

One gap in the dev server: it does not wire `owncast.users.register` or
`owncast.auth.grantSession`, so a successful viewer sign-in answers 503 there
with `users.register is not available on this host`. The login page, form posts
and `onAuthCheck` all work; only the grant needs a real host, which is why the
gate is tested through scenarios (`authCheck`, `sessionGrants`,
`userRegistrations`) rather than in the browser.

`npm run package` runs `owncast-plugin-test --load-only` first — the same
install-time path a server uses — so a package cannot be built from a plugin that
would fail to load.

## Releasing

Merging a version bump is the release. There is no tag to push and no second
command: `main` moving to a version that has no release yet starts
`.github/workflows/release.yml`, which tests the merged commit, tags it, and
publishes `stream-profiles.ocpkg` with `SHA256SUMS.txt`.

The version is recorded in three places, and all three must agree:
`package.json`, `package-lock.json` and `plugin.manifest.json`. Use the script;
`npm version` alone only updates the first two, and the manifest is the one the
host and the catalog read.

```bash
npm run version:bump patch   # or minor / major / 0.1.0
npm run release:verify
git switch -c release/0.0.6
git commit -am "bump: update version to 0.0.6"
git push -u origin HEAD      # then open a PR and merge it
```

`main` is protected, so the bump arrives with both CI jobs green. A run on a
commit whose version is already released stops after a few seconds and does
nothing, and re-running a failed publish reuses the tag it created after
checking that the tag still points at the commit being tested.

The tag is an output of the release, not an input, so it cannot land on the
commit behind the bump. Tags stay protected against deletion and update: a wrong
one is superseded by the next version, never moved.

`scripts/check-release.mjs` refuses the run when the versions disagree, the tag
does not match, the permission set changed, an action is not pinned to a commit
SHA, or the package contains an unexpected file. Run it alone for the fast
version; failures name the rule.

`.github/actions/verify` holds the test and package steps and is used by both CI
and the release, so the two cannot drift. It is a composite action rather than a
reusable workflow because a called job reports its status as
`<caller> / <called>`, which would rename the required check in branch
protection. A release re-runs the steps over the merged commit, independently of
whatever CI produced, and publishes that run's package unchanged: the released
bytes are the ones that passed, not a second build.
```bash
sha256sum -c SHA256SUMS.txt
gh attestation verify stream-profiles.ocpkg \
  --repo FlorianObermayer/owncast-stream-profiles
```

`gh attestation` needs `gh` 2.49 or newer; the checksum check works anywhere.

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

## Viewer authentication

A profile can carry viewer credentials, so the plugin holds `auth.gate` and
`users.register`. Four constraints shape the code; each was established against
Owncast's source rather than its docs:

* **A plugin cannot prompt for HTTP Basic auth.** `services/plugins/server.go`
  filters response headers through an allowlist and `WWW-Authenticate` is not in
  it, so a 401 challenge never leaves the server. Browsers therefore get a form.
  The `Authorization` request header *is* delivered, so non-browser clients that
  send it themselves are accepted.
* **Only one `auth.gate` plugin may be enabled.** This plugin replaces any other
  authentication plugin rather than coexisting with it.
* **The round count in `src/auth.js` is measured, not chosen for taste.** SHA-256
  costs about 1.5 ms per round on the embedded interpreter, so `ROUNDS = 512` is
  roughly 0.75 s per check against a 5 s handler budget. 4096 was measured to
  time out. Salting stops a leaked digest being a direct lookup; the iteration
  count is a speed bump, not a KDF, so password strength still matters.
* **A session records the profile that issued it.** `onAuthCheck` denies a
  session whose profile is no longer active, which is what makes "switching
  profile switches who can watch" true rather than decorative.

When changing credentials, keep the salt and hash server-side: the admin page is
only ever sent `{ id, user, passwordOnly }`.

## Documentation direction

`INSTRUCTIONS.md` is the single source for admin-facing content, because it is the
copy rendered inside Owncast. `README.md` points at it - never the reverse.

It cannot link elsewhere instead: the Instructions tab is rendered inline in the
admin page, so a relative link 404s and an absolute one navigates the admin away.
`scripts/check-release.mjs` enforces absolute links there.
