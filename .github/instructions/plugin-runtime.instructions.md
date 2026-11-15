---
description: "Use when writing plugin code in src/ — sandbox limits, verifying Owncast behaviour, the field schema, viewer authentication, and upgrade safety."
name: "Plugin runtime"
applyTo: "src/**/*.js"
---

# Plugin runtime code

`src/plugin.js` runs inside Owncast's QuickJS sandbox. `src/auth.js` holds the
encoding, hashing and credential-record helpers.

## The sandbox is not Node

No `fetch`, no `btoa`, no `fs`, no `crypto`, no `require` beyond the SDK, and no
`setTimeout` (use `owncast.timer`). `encodeURIComponent` is the only Unicode-safe
primitive guaranteed, which is why base64 and SHA-256 are written by hand in
`src/auth.js`.

- Outbound HTTP is `owncast.http.fetch(url, options)`, gated on `network.fetch`.
  The host strips `Cookie` and `accessToken` from a plugin's inbound request, and
  filters response headers through an allowlist that has no `www-authenticate`.
- Every handler has a budget: 5 s for `onHttpRequest`, so a slow loop is a
  timeout, not a slow page. Hashing costs about 1.5 ms per round, which is why
  `ROUNDS = 512`.
- Granting a session only works inside `onHttpRequest`, and `onAuthCheck` runs
  only on a `GET /` page load — never on the HLS hot path.

## Verify before asserting

Read the Go source in `owncast/owncast` before relying on behaviour:

| Question | File |
| --- | --- |
| What is gated, and with what exemptions | `pluginhost/authgate.go` |
| Session signing, TTL, cookie flags | `services/plugins/authsession.go` |
| Header/body limits, what is stripped from a request | `services/plugins/server.go` |
| How a viewer's identity reaches a plugin | `pluginhost/pluginhost.go` |
| Cache durations | `utils/utils.go`, `GetCacheDurationSecondsForPath` |

When code and documentation disagree, the code is the specification. Say which
file the behaviour comes from, so the next reader can check it.

## The field schema is duplicated on purpose

Adding or changing a profile field means touching both sides together:

1. `FIELD_SPECS` in `src/plugin.js` — `key`, `label`, `path`, `type`, `capture`.
2. `FIELD_DEFS` in `public/admin/admin.js` — `label`, `type`, `group`, `hint`.
3. `DEFAULT_SKIPPED` in **both** files, when a new profile should leave it alone.
4. `activation` in both files, when Owncast reads the value later than it is
   written.
5. A scenario in `__tests__/`.

The plugin does not use its copy of `DEFAULT_SKIPPED`; the page does. Keep them
identical anyway, because a mismatch shows up as a checkbox that disagrees with
what applying the profile actually touches.

## Upgrades must not overwrite settings

`loadProfiles()` passes `skipMissingFields: true`, which adds any key a stored
profile does not have to its `skip` list. Without it, a profile captured before a
field existed normalises to an empty default and applying it wipes whatever the
server is configured with now.

That guard is for profiles read from storage only. Profiles arriving from the
admin page carry every field, and a bare profile posted by a client must still
apply its defaults — do not move the flag into `normalizeProfiles` unconditionally.

## Viewer authentication

- `authenticate()` orders matches deliberately: a named profile credential, then
  the owner login, then a password-only entry. A profile shares one salt, so two
  entries with the same password have identical hashes; without this ordering a
  password-only entry silently stands in and the viewer appears as "Guest".
- The owner login lives at `auth-admin` and its sessions are bound to
  `admin|<id>`, both with their original names after the rename to "Owner login".
  Renaming either would discard a saved credential or invalidate live sessions.
- `onAuthCheck` checks the admin binding **before** any profile logic. That
  ordering is what makes it survive a profile switch and a missing profile; move
  the profile checks first and it becomes an ordinary credential.
- Fail closed with no active profile, open for a profile with no credentials.
  Both are deliberate; changing either changes whether the plugin can lock an
  operator out.

## Known gap

`onAuthCheck` does not consult `user.disabledAt`, so banning the shared chat user
does not revoke viewer access. If you close it, keep the behaviour documented
rather than silently changing what a ban means.
