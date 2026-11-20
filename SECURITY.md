# Security policy

## Reporting a vulnerability

Report privately, not in a public issue: use
**Security → Report a vulnerability** on this repository. That opens a private
advisory with the maintainer and can produce a CVE if warranted.

Include the plugin version (from `plugin.manifest.json` or the release tag), your
Owncast version, and steps to reproduce.

Expect a first reply within a week. This is a hobby project: please do not
disclose publicly until a fix or mitigation is agreed.

## Supported versions

Only the latest release gets fixes.

## How the gate resists abuse

Two controls are worth knowing about when you report something:

* **Sign-in attempts are metered.** A password check is the expensive part of a
  request, and the plugin runtime can be left unusable by overrunning its
  handler deadline. Failed attempts therefore spend from a shared budget before
  any hashing happens, and the budget is measured in hashing work, not in
  attempts — one attempt costs very little on a normal record and roughly
  seventeen times that while a record written by an older release is being
  migrated. A burst is answered with HTTP 429 rather than queued. Per-client
  limiting still belongs at your reverse proxy: the plugin request carries no
  trustworthy client address.
* **Sign-in and sign-out check where the request came from.** A request whose
  browser metadata marks it as cross-site is refused, and sign-out is a POST
  with a confirmation page. Scripted clients that send no browser headers keep
  working.

## Known limitations

* **Signing out ends this browser's session, not the credential's.** Owncast
  strips the `Cookie` header before a plugin sees a request, so the plugin has
  no way to learn which stored session to delete — it can only ask the host to
  clear the browser's copy. A copy of the cookie taken before sign-out is
  honoured until the session's lifetime expires (24 h, renewed by activity),
  the credential is removed or changed, or the plugin is reloaded. On a shared
  or stolen device, change the password rather than only signing out.
* **Origin checks cannot verify the host behind every proxy.** Browsers report
  whether a request is same-origin, and that is the primary signal. When it is
  absent, the plugin compares `Origin`/`Referer` against `X-Forwarded-Host`,
  which a reverse proxy has to set for that comparison to mean anything. A
  proxy that strips all of those headers leaves scripted and older clients
  allowed rather than breaking sign-in for them.
* **Plugin admin pages share one origin, so browser storage is not isolated.**
  Owncast serves every plugin's admin page from the same origin, in a
  same-origin iframe, and `sessionStorage`/`localStorage` are scoped per origin
  rather than per plugin. Anything one plugin's page writes can be read,
  overwritten or deleted by another plugin's admin page open in the same tab.
  Treat browser storage in a plugin page as shared with every plugin you have
  open. This page keeps the admin password in page memory instead, so a reload
  asks for it again.
* **The plugin runtime exposes no cryptographic library.** The plugin runs in
  Owncast's embedded QuickJS interpreter, where the SDK is the only importable
  module: there is no WebCrypto, no Node `crypto`, and no secure random source.
  Password hashing is therefore hand-written: salted SHA-256 with a fixed
  iteration count, sized so one check stays inside the host's request deadline.
  Salts are unique per credential but built from `Math.random`, the clock and a
  counter, because a CSPRNG is not reachable. This is weaker than a memory-hard
  KDF; it protects against readable passwords in Owncast's database and
  backups, not against an offline attack on a database an attacker already has.
