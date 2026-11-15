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
   `Authorization: Basic` header themselves are accepted by the sign-in page,
   but see the access-mode note below before expecting a player to work.
3. **`/admin` stays reachable**, so a mistake here can always be undone.

### Choose what the gate covers

After enabling the plugin, open the **Authentication** tab on the plugin's page
and pick an access mode. This is Owncast's setting, not the plugin's:

| Mode | Also protected |
| --- | --- |
| Website only *(default)* | Nothing — `/hls/*` and `/api/status` stay public |
| Website, video players, and other resources | `/hls/*` |
| Website, video players, and server status requests | `/hls/*` and `/api/status`, Directory listing disabled |

**The default protects the page but not the stream.** Anyone with the HLS URL
can still watch. If the point of the credential is to keep the video private,
choose the second or third mode.

A player such as VLC that sends `Authorization: Basic` cannot use the stricter
two modes: the check covers `/hls/*` itself and a player has no session cookie.
For player access, keep **Website only** and accept that the stream is public.

A reverse proxy doing its own `auth_basic` has the same trade-off and sees the
requests before Owncast does — if one is in place, remove that rule, or it
becomes the only gate that matters.

### Revoking access

Changes take effect the next time the viewer loads the page. Owncast checks the
session on the main page, not on video segments, so someone already watching
keeps watching until they reload. To cut that short, remove the credential and
their next page load signs them out.

Viewers can end their own session at
`/plugins/stream-profiles/auth/logout`. Worth offering when a password is shared.


## Notes

* Applying a non-empty stream title makes Owncast post a "Stream title changed"
  system message in chat.
* The plugin calls Owncast's internal admin API which is not documented and may change in future releases.

## Source and issues

* <https://github.com/FlorianObermayer/owncast-stream-profiles>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/issues>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/blob/main/SECURITY.md>
