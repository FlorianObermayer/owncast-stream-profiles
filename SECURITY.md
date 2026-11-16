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
  handler deadline. Failed attempts therefore spend from a token bucket before
  any hashing happens: eight per site and three per username, refilling over ten
  seconds and a minute respectively. A burst gets HTTP 429 rather than queueing
  up. Per-client limiting still belongs at your reverse proxy — the plugin
  request carries no trustworthy client address.
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
