# Releasing Flowa

1.2.3 is the bridge between the private source repo and the public binaries repo.
Do not tag, publish, or merge until the checks in this file have been run on the
five installers. The update private key stays on the release Mac. Never commit it.

## Where each version looks for updates

| Installed app | `app-update.yml` repo | Where the next update is downloaded |
|---|---|---|
| 1.2.2 and earlier | `maxkongerskov/flowa-electron` | that repo's latest release |
| 1.2.3 and later | `maxkongerskov/flowa-releases` | that repo's latest release |

`latest-mac.yml`, `latest.yml`, and `latest-linux.yml` list file names, not full
GitHub URLs. electron-updater resolves those names against the repo baked into
the running app. The same yaml bytes are valid on both repos.

`scripts/publish-release.sh` always uploads to `maxkongerskov/flowa-releases`.
When the version is exactly `1.2.3`, it then uploads those same files to
`maxkongerskov/flowa-electron`. Later versions are not copied there.
`flowa-releases` does not exist yet. Create it before the first publish.
The script does not create the repo.

## Bridge procedure

### 1. Create the public repo

Create `maxkongerskov/flowa-releases` as a public repository at release time.
It holds installers only. Do not push this source tree there, and do not put
the update private key there.

```bash
gh repo create maxkongerskov/flowa-releases --public --description "Flowa installers"
```

`gh auth status` must be able to publish to both `flowa-releases` and
`flowa-electron`.

### 2. Publish 1.2.3 to both repos

On the release Mac, with the Vulkan trees staged (see README) and
`package.json` already at `1.2.3`:

```bash
npm run release -- 1.2.3
```

That command tests, builds, tags, and runs `scripts/publish-release.sh`.
The script uploads every installer, blockmap, and `latest*.yml` to
`flowa-releases`, then uploads that same set to `flowa-electron`.
Both releases stay drafts until every file for that repo is present, then
each is marked Latest.

Confirm the asset names match and the feed files are the same bytes:

```bash
gh release view v1.2.3 --repo maxkongerskov/flowa-releases --json assets --jq '.assets[].name' | sort > /tmp/flowa-releases.txt
gh release view v1.2.3 --repo maxkongerskov/flowa-electron --json assets --jq '.assets[].name' | sort > /tmp/flowa-electron.txt
diff /tmp/flowa-releases.txt /tmp/flowa-electron.txt

rm -rf /tmp/feed-releases /tmp/feed-electron
mkdir -p /tmp/feed-releases /tmp/feed-electron
gh release download v1.2.3 --repo maxkongerskov/flowa-releases --pattern 'latest*.yml' --dir /tmp/feed-releases
gh release download v1.2.3 --repo maxkongerskov/flowa-electron --pattern 'latest*.yml' --dir /tmp/feed-electron
shasum -a 256 /tmp/feed-releases/* /tmp/feed-electron/*
cmp /tmp/feed-releases/latest-mac.yml /tmp/feed-electron/latest-mac.yml
cmp /tmp/feed-releases/latest.yml /tmp/feed-electron/latest.yml
cmp /tmp/feed-releases/latest-linux.yml /tmp/feed-electron/latest-linux.yml
```

`diff` and each `cmp` must succeed. A mismatch means 1.2.2 and a hand-installed
1.2.3 would not be offered the same files.

### 3. Verify 1.2.2 → 1.2.3 on all five installers

Install the already-published 1.2.2 build, whose feed is `flowa-electron`:

1. Mac Apple Silicon dmg
2. Mac Intel dmg
3. Windows NSIS exe
4. Linux AppImage
5. Linux deb

On each one, use Home → Check for updates. It must offer 1.2.3, download it
from `https://github.com/maxkongerskov/flowa-electron/releases/`, install, and
restart as 1.2.3. Then open the installed app's `app-update.yml` and confirm
it contains `repo: flowa-releases`.

Do not publish a later version until all five have done this.

### 4. Confirm 1.2.3 → 1.2.4 reads flowa-releases

This hop uses a throwaway 1.2.4. It is not the public next release.
Build it with the same update signing key as 1.2.3, or the installed app
rejects the signature. `npm run release -- 1.2.4` uploads to `flowa-releases`
only, because the version is not `1.2.3`.

On each of the five machines that just became 1.2.3, check for updates again.
Each must offer 1.2.4 and download it from
`https://github.com/maxkongerskov/flowa-releases/releases/`, not from
`flowa-electron`.

Leave one machine on 1.2.2 while 1.2.4 is Latest on `flowa-releases`.
That machine must not offer 1.2.4. Its feed is still `flowa-electron`, and
1.2.4 was not uploaded there. That is the proof the second hop left the
source repo.

Then take the throwaway down so production stays on 1.2.3:

```bash
gh release delete v1.2.4 --repo maxkongerskov/flowa-releases --yes
git push origin :refs/tags/v1.2.4
gh release edit v1.2.3 --repo maxkongerskov/flowa-releases --latest
```

Reinstall 1.2.3 on any machine that took the throwaway. electron-updater will
not downgrade it. Do not leave `v1.2.4` tagged on origin, and do not merge a
commit whose only purpose was the throwaway version bump.

## Rollback

electron-updater does not install an older version. Pulling 1.2.3 only stops
people who are still on 1.2.2 from being offered it. People already running
1.2.3 stay there until 1.2.4.

### Pull a bad 1.2.3

Do this on both repos. Drafting is reversible. Deleting the release removes
its `latest*.yml` with it. Either way, 1.2.2 has to be Latest on
`flowa-electron` again, or 1.2.2 installs keep reading the bad feed.

Draft, and drop the feed files off the draft:

```bash
for repo in maxkongerskov/flowa-electron maxkongerskov/flowa-releases; do
  gh release edit v1.2.3 --repo "$repo" --draft --latest=false
  gh release delete-asset v1.2.3 latest-mac.yml --repo "$repo" --yes
  gh release delete-asset v1.2.3 latest.yml --repo "$repo" --yes
  gh release delete-asset v1.2.3 latest-linux.yml --repo "$repo" --yes
done
gh release edit v1.2.2 --repo maxkongerskov/flowa-electron --latest
```

Or delete the release on both repos. This also deletes `latest*.yml`:

```bash
gh release delete v1.2.3 --repo maxkongerskov/flowa-electron --yes
gh release delete v1.2.3 --repo maxkongerskov/flowa-releases --yes
gh release edit v1.2.2 --repo maxkongerskov/flowa-electron --latest
```

Leave the `v1.2.3` git tag in place if a corrected build will reuse that
version number. Delete the tag only when 1.2.3 will not be published again.

After this, a 1.2.2 install checks `flowa-electron`, finds 1.2.2 as Latest,
and stays put.

### People already on 1.2.3

They do not return to 1.2.2. Their `app-update.yml` points at
`flowa-releases`. Ship the fix as 1.2.4 to that repo only:

```bash
npm run release -- 1.2.4
```

`publish-release.sh` does not upload 1.2.4 to `flowa-electron`. Those installs
check for updates, download 1.2.4 from `flowa-releases`, and restart into it.

People who never installed the bad 1.2.3 are still on 1.2.2. They will not
see 1.2.4. To move them, publish a corrected 1.2.3 to both repos again
(the bridge rule is the version number, not a flag). Replacing the 1.2.3
files updates anyone still on 1.2.2. It does not update anyone already
running 1.2.3, because the version did not change. Those installs need 1.2.4.
