# Scope for this scan

Source only. This is an Owncast plugin, not a server: there is nothing here to
attack over the network in CI, and no credentials belong in this file. Do not
send requests to any host.

# Where the risk is

- `src/auth.js` — hand-written SHA-256 and base64, password hashing and the
  round count stored with each digest, credential records, `safeReturnTo`.
- `src/plugin.js` — the viewer gate (`/`, `/auth/login`, `/auth/logout`), form
  and HTTP Basic parsing, session bindings, the same-origin check, the sign-in
  attempt budget, and the admin JSON API.
- `scripts/check-release.mjs` — what the release guard does *not* prove.
- `.github/` — workflow permissions, action pinning, artifact sealing.

# Reporting

Report a finding only with the source path and the request or call that reaches
it. Defence-in-depth notes are welcome when labelled as such; speculation is not.
