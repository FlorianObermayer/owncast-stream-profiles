# Stream Profiles

An Owncast plugin that saves the settings describing a broadcast as a named
profile, and switches between them in one click — title, About text, messages,
page content, tags, discovery flags, chat policy and branding.

Requires Owncast `0.3.0` or newer.

![Profile list](.github/images/admin-overview.png)

The plugin groups its fields into Content, Discoverability, Chat, Advanced and
Branding.

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

One setting: `owncastUrl` in **Plugins → Stream Profiles → Settings**. Then press
**Capture current settings** on the Profiles tab to import what the server
already uses.

## Development

Check [CONTRIBUTING.md](CONTRIBUTING.md) for more details on the development workflow.