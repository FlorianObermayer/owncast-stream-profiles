# Stream Profiles

Save the settings that describe a broadcast as a named profile, then switch
between profiles instead of retyping them.

## Set up

Open **Plugins → Stream Profiles → Profiles**, then press **Capture current
settings** to turn what the server already uses into your first profile. Confirm
your Owncast admin password when asked.

## The one rule worth knowing

Each field has a checkbox.

* **Checked** — written from this profile.
* **Unchecked** — left alone on the server, whatever the profile says.
* **Checked and empty** — cleared on the server.

That is what makes applying a profile predictable: a field you did not tick
cannot change.

**Save changes** keeps your edits. **Apply now** makes the profile the active one
and changes the server.

Some fields take effect as soon as the profile is applied, others a little later.
A badge on the field tells you which, and the status line lists anything still
waiting.

## Who can watch

Each profile has its own **Viewer access** list, so switching profile can also
switch who is allowed to watch.

| Entries | What viewers get |
| --- | --- |
| none | The site is open. |
| one or more | A sign-in page. Any listed credential is accepted. |

A credential is a username with a password, or a password on its own. A password
on its own accepts any username, which is the closest equivalent to the single
password some reverse proxies ask for.

Passwords are never stored or shown in readable form.

**Apply a profile before enabling the plugin.** With no profile applied the site
is closed to viewers. The admin pages stay reachable either way, so a mistake can
always be undone from there.

### What the sign-in protects

After enabling the plugin, open the **Authentication** tab on its page and pick a
mode. This is Owncast's setting:

| Mode | Also protected |
| --- | --- |
| Website only *(default)* | Nothing: the video itself stays public |
| Website, video players, and other resources | The video, for players too |
| Website, video players, and server status requests | The video, plus the "is it live" status |

**The default protects the page but not the video.** Anyone with a copy of the
video link can still watch. If the point of the password is to keep the stream
private, choose the second or third mode.

Those two stricter modes cannot be used by a player app such as VLC, because a
player cannot fill in a sign-in page. If player access matters more than privacy,
stay on **Website only** and accept that the video is public.

Owncast allows one sign-in plugin at a time. Enabling this one replaces any other
authentication plugin you had.

### Owner login: always available

At the top of the Profiles page, **Owner login** is one username and password
that is not attached to any profile. It is not a privileged account — it lets you
watch, nothing more — but it works whatever profile is active, and even when none
is. That is what makes it useful: a mistake in a profile's viewer access cannot
lock you out of your own site.

Two things to keep in mind:

* **It is one more way in.** Anyone who knows it can watch, whatever the profile
  says. Give it a password you do not hand out.
* **Changing it signs out anyone using the old one.**

### Signing out

Changes take effect the next time a viewer loads the page, so someone already
watching keeps watching until they reload. Removing the credential is what ends
their access.

To end a session on this device, visit
`/plugins/stream-profiles/auth/logout`.

## Notes

* Applying a profile with a stream title asks Owncast to announce the new title
  in chat.
* Requires Owncast `0.3.0` or newer.

## Source and issues

* <https://github.com/FlorianObermayer/owncast-stream-profiles>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/issues>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/blob/main/SECURITY.md>
