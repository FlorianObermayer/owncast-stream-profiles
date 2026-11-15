# Stream Profiles

An Owncast plugin that saves the settings describing a broadcast as a named
profile, and switches between them in one click — title, About text, messages,
page content, tags, discovery flags, chat policy and branding.

Requires Owncast `0.3.0` or newer.

![Profile list](.github/images/admin-overview.png)

The plugin groups its fields into Content, Discoverability, Chat, Advanced and
Branding.

Each profile can also carry its own **viewer access** list — usernames with
passwords, or shared passwords with no username — so switching profile switches
who is allowed to watch. Passwords are never stored or shown in readable form.

One login is deliberately **not** tied to a profile: an owner login (no extra
privileges, just a way in) that works whatever profile is active, and even when
none is. It exists so a mistake in a profile's access list cannot lock the owner
out.

Viewers sign in on a page rather than through a browser dialog, so a player app
cannot use it. What the sign-in protects — the page only, or the video too — is
Owncast's own **Authentication** setting, and the default leaves the video
public. See [INSTRUCTIONS.md](INSTRUCTIONS.md).

## Install

Download `stream-profiles.ocpkg` from the repository's Releases page, then in the
Owncast admin: **Plugins → Upload plugin**, review the permissions, enable it.

Optionally verify the download first — compare it against `SHA256SUMS.txt` from
the same release, or check its signed provenance with the `gh` CLI:

```bash
gh attestation verify stream-profiles.ocpkg \
  --repo FlorianObermayer/owncast-stream-profiles
```

`gh attestation` needs `gh` 2.49 or newer. Debian packages are older than that;
compare the file against `SHA256SUMS.txt` instead, which needs only `sha256sum`.

## Set up

No settings to fill in. Open the **Profiles** tab and press **Capture current
settings** to import what the server already uses into your first profile.

The viewer access list is optional and empty by default, and an empty list on an
**active** profile leaves the site open. With no profile active at all the site
stays closed to viewers, so apply a profile before enabling the plugin — the
admin pages stay reachable either way. See [INSTRUCTIONS.md](INSTRUCTIONS.md) for
the full behaviour.

## Development

Check [CONTRIBUTING.md](CONTRIBUTING.md) for more details on the development workflow.