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
plugin through. `npm ci` downloads that binary; the tag is pinned by
`OWNCAST_PLUGIN_HOST_BINARIES_VERSION` (already set in CI).

Use npm 11 or newer locally. CI installs with
`NPM_CONFIG_STRICT_ALLOW_SCRIPTS=true`, so a dependency whose install script is
not in `package.json`'s `allowScripts` list fails the build. Add its exact
version there in the same commit as the dependency.

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

* `expect.kv` is **partial** — only the keys you list are checked.
* `expect.httpRequests` is an **exact ordered list**, so adding a field means
  updating any scenario that applies it.
* An outbound call with no matching `given.httpResponses` fixture fails the
  scenario, by design.
* Set **`authenticated: true`** on `/admin/api/*` steps, or the host answers 401
  before our code runs. Omit it to assert that gate.
* The **admin password goes in the request body**, never `given.config`: pass
  `{"password": "..."}` on apply and server calls.
* Gateway fixtures seed credentials under `auth:<profileId>`, and the stored hash
  depends on `ROUNDS` — put `"rounds": 32` in new ones.
  `auth-security.test.json` pins the redirect, throttle, cross-origin, sign-out
  and migration behaviour.

`npm run serve` (`PORT=8765` to change) adds dev-only endpoints for handlers HTTP
cannot reach: `POST /_dev/chat`, `GET /_dev/chat`, `POST /_dev/event`. Restart it
after code changes.

The dev server does not wire `owncast.users.register` or
`owncast.auth.grantSession`, so a successful viewer sign-in answers 503 there.
That is why the gate is tested through scenarios (`authCheck`, `sessionGrants`,
`userRegistrations`) rather than in the browser.

`npm run package` runs `owncast-plugin-test --load-only` first — the same
install-time path a server uses — so a package cannot be built from a plugin that
would fail to load.

## Releasing

Merging a version bump is the release. There is no tag to push and no second
command: `main` moving to a version that has no release yet starts
`.github/workflows/release.yml`, which tests the merged commit, tags it, and
publishes `stream-profiles.ocpkg` with `SHA256SUMS.txt`.

The version is recorded in four places and all four must agree: `package.json`,
`package-lock.json`, `plugin.manifest.json`, and the `?v=` query on the admin
CSS/JS in `public/admin/index.html`. Use the script — `npm version` updates only
the first two. The query is load-bearing: Owncast caches `.js`/`.css` for 30 days,
so an upgrade with an unchanged URL looks like a missing feature.

```bash
npm run version:bump patch   # or minor / major / 0.1.0
npm run release:verify
git switch -c release/0.0.6
git commit -am "bump: update version to 0.0.6"
git push -u origin HEAD      # then open a PR and merge it
```

`main` is protected, so the bump arrives with CI green. The tag is an output of
the run, never an input, and tags are immutable: a wrong release is superseded by
the next version, not moved.

`scripts/check-release.mjs` refuses a release when the versions disagree, the tag
does not match, the permission set changed, an action is not pinned to a SHA, an
install script is not covered by `allowScripts`, the downloaded host binary does
not match its pinned digest, or the package contains an unexpected file. Run it
alone for the fast version.

`.github/actions/verify` holds the test and package steps for both CI and the
release. It is a composite action, not a reusable workflow, because a called job
would rename the required check in branch protection. The release re-runs those
steps over the merged commit and publishes that package unchanged.

Operators verify a download with:

```bash
sha256sum -c SHA256SUMS.txt
gh attestation verify stream-profiles.ocpkg \
  --repo FlorianObermayer/owncast-stream-profiles
```

Both describe the file the workflow sealed, and the workflow runs a downloaded
`owncast-plugin-test` binary before sealing — which is why `HOST_BINARY_SHA256`
pins it. When you bump `OWNCAST_PLUGIN_HOST_BINARIES_VERSION`, reinstall, confirm
the binary against the upstream release, and update the digest in the same
commit.

Adding a **permission** is user-visible: every installed copy shows "needs
re-approval" until an admin approves. Update `EXPECTED_PERMISSIONS` in
`scripts/check-release.mjs` in the same commit.

## AI security scan

`.github/workflows/strix.yml` runs the [strix](https://github.com/usestrix/strix)
scanner on every pull request (diff-scoped), weekly, and on demand. It is
provider-agnostic: set the `STRIX_LLM` variable to any LiteLLM model id and the
`LLM_API_KEY` secret to that provider's key; `LLM_API_BASE` is optional. The
gotchas:

* **Pull requests are scanned only when the branch is in this repository.** A
  fork's PR gets no secrets, so the job is skipped rather than left red. That
  guard also matters because the scan reads `.github/strix-instruction.md` from
  the PR's own checkout.
* **Never a self-hosted runner** while this repository is public: a fork can edit
  a workflow file and have that job run on your machine.
* **The endpoint must be reachable from GitHub**, so not a LAN-only gateway. A
  gateway model alias also isn't in LiteLLM's price catalogue, so cost reports as
  `0` and `--max-budget` never trips; set `STRIX_LLM_*_COST_PER_MTOK` if you use one.
* **Findings never fail the job**, including the SARIF upload: an LLM scanner
  isn't deterministic, so gate on it only deliberately, with `--fail-on high`.
  Findings land in the **Security → Code scanning** tab instead.
* **It only sees source.** The 2026-11 report's best findings came from attacking
  the deployment with real credentials; do that by hand.
* **`strix_runs/` stays out of commits**; CI uploads it as the `strix-run`
  artifact.

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
`users.register`. Each line below is a constraint that breaks something if you
change it; all were established against Owncast's source, not its docs.

* **A plugin cannot prompt for HTTP Basic auth.** The host filters response
  headers and drops `WWW-Authenticate`, so browsers get a form. The
  `Authorization` request header *is* delivered, so scripted clients work.
* **Only one `auth.gate` plugin can be enabled.** This one replaces any other
  rather than coexisting with it.
* **The protected surface is the operator's setting, not the plugin's.** The
  default leaves `/hls/*` and `/api/status` public, so credentials do not imply a
  private video.
* **`onAuthCheck` runs on page loads only**, never on the HLS hot path.
  Revocation therefore takes effect at the viewer's next load, and the session
  TTL is the backstop.
* **Overrunning the 5 s handler deadline kills the plugin**, it does not slow the
  request, and nothing reloads it. Budget every handler as if overrunning were
  fatal; `ROUNDS` is 32 for exactly that reason.
* **Stored digests are tied to `ROUNDS`.** Every record carries `rounds` and is
  verified at that count. Never default an unlabelled record to a count: it may
  have come from a release that used a different one, which makes it permanently
  unverifiable.
* **A failed sign-in must do the same hashing work whatever the username.**
  Returning early when nothing matches makes response time reveal which
  usernames exist, so the lookup hashes every salt and count in force.
* **Attempts are budgeted before hashing, in rounds rather than count.** A record
  without a count costs both counts to verify, so counting attempts would let a
  small burst exceed the deadline.
* **Sign-in and sign-out are same-origin only**, and sign-out is a POST. The
  gates are `Sec-Fetch-Site`, then `Origin`/`Referer` against
  `X-Forwarded-Host`.
* **Sign-out cannot revoke the binding.** The host strips the `Cookie` header and
  leaves `req.user` empty on these routes, so only the TTL or a credential change
  ends a copied cookie.
* **One salt per profile means identical passwords hash identically**, so a named
  entry must be preferred over a password-only one. Otherwise a viewer is
  admitted as `Guest` under someone else's credential.
* **The owner login is profile-independent** and checked before any profile
  logic; that ordering is what makes it an anti-lockout escape hatch. Its storage
  key and session scope keep the old `admin` names so a rename cannot discard a
  saved credential.
* **A session records its issuer**, which is what makes switching profile revoke
  the previous profile's viewers.

Keep the salt and hash server-side: the admin page is only ever sent
`{ id, user, passwordOnly }`.

## Documentation direction

`INSTRUCTIONS.md` is the single source for admin-facing content, because it is the
copy rendered inside Owncast. `README.md` points at it - never the reverse.

It cannot link elsewhere instead: the Instructions tab is rendered inline in the
admin page, so a relative link 404s and an absolute one navigates the admin away.
`scripts/check-release.mjs` enforces absolute links there.
