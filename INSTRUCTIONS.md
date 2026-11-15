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


## Notes

* Applying a non-empty stream title makes Owncast post a "Stream title changed"
  system message in chat.
* The plugin calls Owncast's internal admin API which is not documented and may change in future releases.

## Source and issues

* <https://github.com/FlorianObermayer/owncast-stream-profiles>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/issues>
* <https://github.com/FlorianObermayer/owncast-stream-profiles/blob/main/SECURITY.md>
