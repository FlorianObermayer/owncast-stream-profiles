# Stream Profiles

Save the settings that describe a broadcast as a named profile, then switch
between profiles instead of retyping them.

## First run

Set `owncastUrl` in **Plugins → Stream Profiles → Settings**: this server's base
URL as reachable *from the server itself*. Defaults to `http://127.0.0.1:8080`.

Then open **Profiles → Capture current settings** to turn what the server already
uses into your first profile.

## The one rule worth knowing

Each field has a checkbox.

* **Checked** — written from this profile.
* **Unchecked** — left alone on the server, whatever the profile says.
* **Checked and empty** — cleared on the server.

That is what makes an apply predictable: a field you did not tick cannot change.

## Admin password

Applying needs your Owncast admin password, because Owncast's plugin API has no
setter for these settings.

## Viewer access per profile

Each profile carries its own list of viewer credentials, under **Viewer access**
in the profile editor. It applies only while that profile is active, so switching
profiles switches who can watch.

| Entries | What viewers get |
| --- | --- |
| none | The site is open. |
| one or more | A sign-in page. Any listed credential is accepted. |

With **no profile applied at all** the gate stays closed, so apply a profile
before enabling the plugin. `/admin` is always reachable, so this is fixable
without touching the server.

A credential with a username requires that username. A credential without one
is a shared password: any username works, only the password is checked. That is
the closest equivalent to the simple password on a reverse proxy.

Passwords are stored as a salted SHA-256 hash, never in readable form, and never
leave the server — the admin page only ever shows usernames.

**Three things to know before using this:**

1. **The plugin becomes the site's login gate.** Owncast allows only one plugin
   with the `auth.gate` permission to be enabled at a time. If another
   authentication plugin is enabled, this one replaces it.
2. **Browsers get a sign-in page, not the small browser dialog.** Owncast filters
   the response headers a plugin may set, and the one a browser needs to prompt
   for HTTP Basic auth is not among them. Players and scripts that send an
   `Authorization: Basic` header themselves are still accepted.
3. **`/admin` stays reachable**, so a mistake here can always be undone.

If a reverse proxy already asks for a password in front of Owncast, remove that
rule: otherwise viewers are asked twice, and the proxy becomes the only thing
that matters.


## Notes

* Applying a non-empty stream title makes Owncast post a "Stream title changed"
  system message in chat.
* The plugin calls Owncast's internal admin API which is not documented and may change in future releases.

## Source and issues

* <https://github.com/FlorianObermayer/owncast-stream-profiles>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/issues>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/blob/main/SECURITY.md>
