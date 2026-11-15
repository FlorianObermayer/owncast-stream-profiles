---
name: release-plugin
description: "Use when releasing a new version of the Stream Profiles plugin, bumping the version, publishing a .ocpkg, or diagnosing the release workflow. Covers the four version sites, the merge-triggered publish, and verifying the published assets."
---

# Release the plugin

Merging a version bump **is** the release. `main` is protected, the release
workflow finds a version with no release yet, verifies the merged commit, tags it,
and publishes the `.ocpkg`. Nothing is tagged or uploaded by hand.

## Steps

1. Branch from an up-to-date `main`.
2. Bump with the script — never `npm version`, which updates two of the four
   version sites:

   ```bash
   npm run version:bump patch     # or minor / major / 0.1.0
   npm run release:verify
   ```

   Use `minor` for a new field or behaviour, `patch` for a fix. Check
   `gh release list` first: if the manifest version is already published, the
   release workflow will correctly do nothing, so bump before opening the PR.

3. Commit, push the branch, open a PR. Title it for the change, not the bump.
4. Wait for **Test and package** and **Review dependency changes** to pass —
   both are required checks. `mergeStateStatus: CLEAN` means merges will work.
5. Squash-merge.
6. Confirm the release, don't assume it:

   ```bash
   gh release list | head -3
   git fetch --tags && git rev-parse --short v<version>^{commit}
   gh run list --workflow=release.yml --limit 1
   ```

   The tag must point at the merge commit on `main`.

7. Verify the assets a user would download:

   ```bash
   cd /tmp && gh release download v<version> --repo FlorianObermayer/owncast-stream-profiles
   sha256sum -c SHA256SUMS.txt
   gh attestation verify stream-profiles.ocpkg --repo FlorianObermayer/owncast-stream-profiles
   ```

   `gh attestation` needs `gh` 2.49 or newer; the checksum check works anywhere.
   Also confirm the manifest version inside the package matches the tag.

## The four version sites

`scripts/set-version.mjs` rewrites all of them, and
`scripts/check-release.mjs` fails when they disagree:

| File | Why |
| --- | --- |
| `package.json` | tooling |
| `package-lock.json` | `npm ci` compares it against `package.json` |
| `plugin.manifest.json` | what the host and the catalog read |
| `public/admin/index.html` | the `?v=` on `admin.css` / `admin.js` |

That fourth one is not cosmetic. `.js` and `.css` are served with a 30-day
`max-age`, so without a changed query string an upgraded plugin keeps serving the
previous release's script and the admin page silently lacks whatever was added.
A version bump that skips it ships a broken upgrade, and the symptom presents as
"the feature is missing" rather than as a cache problem.

## Traps, each of which happened

- **Never tag by hand, and never tag a commit that is not the merge commit.** An
  early release was tagged on the commit *behind* the bump; the tag pointed at a
  manifest that still said the old version, and the run failed its own guard.
  The workflow creates the tag now, from the commit it just tested.
- **Release tags are protected against deletion and update.** A wrong tag is
  superseded by the next version, never moved. Confirm before publishing.
- **A permission change forces re-approval** on every installed copy. Widening
  `EXPECTED_PERMISSIONS` in `scripts/check-release.mjs` is a deliberate,
  reviewable act — say so in the PR and in the release notes.
- **If the PR is merged while you are still working**, your branch holds a commit
  whose content is already in `main` under a different SHA. Replay only the new
  commit: `git rebase --onto origin/main <merged-commit> <branch>`, then
  `git push --force-with-lease`.
- **`gh pr merge` output can be misleading** when checked too soon. Confirm with
  `gh api repos/<owner>/<repo>/pulls/<n> --jq '{state, merged, merged_sha}'`.

## If the release fails

Read the failed step, not the conclusion. A tag/manifest mismatch means the tag was
placed wrongly; a package-check failure names the rule it broke. Retrying is safe:
the workflow reuses an existing tag only after verifying it points at the commit
being tested, and gates on whether a *release* exists rather than whether a tag
does, so a publish that failed after tagging stays retryable without burning a
version.
