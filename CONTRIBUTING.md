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

Use npm 11 or newer locally. `package.json` declares an `allowScripts` allowlist
and CI installs with `NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true`, so an install script
missing from that list fails the build rather than running unreviewed. Adding a
dependency that needs one means adding its exact version there in the same
commit.

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
| `scripts/set-version.mjs` | Bumps the version in all four files at once |
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

A field added to an existing release needs no migration: profiles stored before it
existed have no value for it, and `loadProfiles` adds such keys to their `skip`
list so applying an old profile cannot overwrite whatever the server is
configured with now. Add it to `DEFAULT_SKIPPED` as well when even a *new* profile
should leave it alone.

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
  stored hash depends on `ROUNDS` in `src/auth.js`. A record carrying an explicit
  `rounds` field is verified only at that count, so add `"rounds": 32` to new
  fixtures; a record without one is tried at both the current and the legacy
  count and is upgraded on sign-in. `__tests__/auth-security.test.json` pins the
  redirect, attempt-budget, cross-origin, sign-out and migration behaviour.

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

The version is recorded in four places, and all four must agree:
`package.json`, `package-lock.json`, `plugin.manifest.json`, and the `?v=` query
on `admin.css`/`admin.js` in `public/admin/index.html`. Use the script;
`npm version` alone only updates the first two, and the manifest is the one the
host and the catalog read.

That fourth one is not cosmetic: Owncast serves `.js` and `.css` with a 30-day
`max-age` (`utils.GetCacheDurationSecondsForPath`), so a browser that has loaded
the admin page once keeps running that release's script for a month. Without a
changed URL an upgrade looks like a missing feature, which is exactly how 0.2.0
appeared to have no owner login. The release guard fails when the query drifts
from the manifest version.

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
SHA, an install script is not covered by the `allowScripts` policy, the
downloaded host binary does not match its pinned digest, or the package contains
an unexpected file. Run it alone for the fast version; failures name the rule.

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

Attestation and the checksum describe the file the workflow sealed, and the
workflow runs `owncast-plugin-test` — a downloaded native binary — before that
sealing. `HOST_BINARY_SHA256` in `scripts/check-release.mjs` pins it so a
replaced release asset becomes a failed check instead of a silent backdoor.
When you bump `OWNCAST_PLUGIN_HOST_BINARIES_VERSION`, reinstall, confirm the new
binary against the upstream release, and update the digest in the same commit.

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
`users.register`. Six constraints shape the code; each was established against
Owncast's source rather than its docs:

* **A plugin cannot prompt for HTTP Basic auth.** `services/plugins/server.go`
  filters response headers through an allowlist and `WWW-Authenticate` is not in
  it, so a 401 challenge never leaves the server. Browsers therefore get a form.
  The `Authorization` request header *is* delivered, so non-browser clients that
  send it themselves are accepted.
* **Only one `auth.gate` plugin may be enabled.** This plugin replaces any other
  authentication plugin rather than coexisting with it.
* **How much is gated is the operator's setting, not the plugin's.**
  `pluginhost/authgate.go` reads a host-owned access mode: the default leaves
  `/hls/*` and `/api/status` exempt, and only the stricter modes gate them.
  Credentials therefore do not imply a private stream, and the docs say so.
* **`onAuthCheck` runs only on a `GET /` navigation**, never on the HLS hot path,
  so revocation is page-load granularity. A viewer already watching keeps the
  stream until they reload; the session TTL is the hard backstop.
* **The host's session TTL is absolute, 24 h by default**
  (`plugins.DefaultSessionTTL`). Returning `authCheck.refresh({ ttl })` on a
  valid page load makes it sliding, which is why `onAuthCheck` refreshes rather
  than merely accepts.
* **Exceeding the handler timeout does not produce a slow response, it kills the
  plugin.** The engine is compiled with wazero's `CloseOnContextDone`, so a call
  that overruns its 5 s context closes the wasm module; every later call fails
  with `module is closed`, `isWasmCorrupted` does not match that string, and
  nothing reloads it. The site stays down until an admin presses **Reload** on
  the plugin. Budget every handler as if overrunning were fatal, because it is.
* **The round count in `src/auth.js` follows from that.** It is 32, about 50 ms
  per check on the embedded interpreter. 512 rounds (~0.8 s here, and plausibly
  over the budget on a small server) shipped in `0.3.0` and took a site down with
  exactly the failure above. Salting stops a leaked digest being a direct
  lookup; the iteration count is a speed bump, not a KDF, so password strength
  still matters.
* **A hashing parameter change is a migration, not a tweak.** Lowering `ROUNDS`
  from 512 to 32 in `0.3.1` invalidated every stored digest and locked every
  deployment out, including the owner login. Every record now stores `rounds`;
  a record without one is ambiguous between the two releases and is tried at
  both counts, current first, then rewritten at the current one. Do not default
  an unlabelled record to a count — that labels a `0.3.1` record as legacy and
  makes it permanently unverifiable.
* **A failed sign-in must cost the same whether or not the username exists.**
  The lookup hashes every salt and round count in force before comparing
  anything, and an empty credential set still spends one hash against a fixed
  salt. Returning early was a timing oracle that told an unauthenticated caller
  which usernames were real.
* **Every attempt is budgeted before it hashes.** A token bucket in KV (five per
  site, three per username) keeps a burst inside the handler deadline. The
  bucket state is written before the hash starts, so concurrent requests cannot
  all pass the check while the first one runs. The bucket is not keyed on a
  client address: the request carries none the caller cannot choose.
* **Sign-in and sign-out are same-origin only.** Email clients, other sites and
  prefetchers must not be able to submit the form or end a session. The primary
  signal is `Sec-Fetch-Site`, which page script cannot forge; `Origin`/`Referer`
  against `X-Forwarded-Host` is the fallback. Sign-out is a POST and the old GET
  URL renders a confirmation page.
* **Sign-out cannot revoke the binding.** `on_http_request` never receives the
  `Cookie` header — the host deletes it before the handler runs — and
  `endSession()` only clears the browser's copy, so a cookie copied beforehand
  keeps working until the credential changes or the TTL ends. `req.user` is not
  populated on these public routes either. Do not pretend otherwise in docs; the
  CSRF fix is what removes the third-party trigger.
* **A shared salt makes identical passwords identical hashes**, so matching must
  prefer an entry that names the viewer over a password-only one. `0.1.1` did
  not, and a password-only entry added earlier silently stood in for a named
  credential — the viewer was let in as `Guest` instead of their username. Keep
  that ordering in `findMatchingCredential` and keep the test that pins it.
* **The owner login is profile-independent by design.** It lives at
  `auth-admin` rather than under a profile, `authenticate` checks it before
  password-only entries, and `onAuthCheck` accepts a session bound to
  `admin|<id>` before any profile logic runs. That ordering is what makes it a
  lockout escape hatch; moving the profile checks first would quietly break it.
  Replacing it mints a new id, which revokes the sessions it issued.

  The stored key and the session scope keep their old `admin` names on purpose.
  Only the wording is "owner login", because it grants no privileges and calling
  it admin access was misleading. Renaming the key would discard a credential an
  owner had already saved — losing exactly the thing that prevents lockouts.

A session also records its issuer, so `onAuthCheck` denies one whose profile is
no longer active — that is what makes "switching profile switches who can watch"
true rather than decorative.

The `basic-auth` example in the SDK is worth reading for the shape of the flow,
but not for its details: it submits the password in a GET query string. Passwords
belong in a POST body here, which is why the login route is POST only.

When changing credentials, keep the salt and hash server-side: the admin page is
only ever sent `{ id, user, passwordOnly }`.

## Documentation direction

`INSTRUCTIONS.md` is the single source for admin-facing content, because it is the
copy rendered inside Owncast. `README.md` points at it - never the reverse.

It cannot link elsewhere instead: the Instructions tab is rendered inline in the
admin page, so a relative link 404s and an absolute one navigates the admin away.
`scripts/check-release.mjs` enforces absolute links there.
