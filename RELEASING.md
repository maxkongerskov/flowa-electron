# Releasing Flowa

Flowa is MIT. Installers and the update feed both live on
`maxkongerskov/flowa-electron`. Do not tag, publish, or merge until the checks
in this file have been run on the five installers. The update private key stays
on the release Mac. Never commit it.

## Where updates are published

Every installed version, including 1.2.2 and 1.2.3, reads
`maxkongerskov/flowa-electron`. `scripts/publish-release.sh` uploads to that
repo only.

`latest-mac.yml`, `latest.yml`, and `latest-linux.yml` list file names, not
full GitHub URLs. electron-updater resolves those names against the repo baked
into the running app.

## Publish 1.2.3

On the release Mac, with the Vulkan trees staged (see README) and
`package.json` already at `1.2.3`:

```bash
npm run release -- 1.2.3
```

That command tests, builds, tags, and runs `scripts/publish-release.sh`.
The release stays a draft until every installer, blockmap, and `latest*.yml`
is uploaded, then it is marked Latest.

```bash
gh release view v1.2.3 --repo maxkongerskov/flowa-electron --json assets --jq '.assets[].name'
```

The installed app's `app-update.yml` contains `repo: flowa-electron`.

## Verify 1.2.2 → 1.2.3

Windows NSIS, Linux AppImage, and Linux deb are covered by
`.github/workflows/real-update-122.yml`. That job installs the published
v1.2.2 files from
`https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.2.2` and
serves a locally built slim 1.2.3 from the same feed name. It does not run
on macOS. Mac arm64 and x64 are the local section below.

On each installer, pass means:

- the running version is 1.2.3
- the speech plan matches the machine (CPU on the CI runners, which have no
  usable GPU; Metal on a Mac whose engine was staged)
- language, microphone, hardware preference, and history are unchanged

Do not publish until all five have done this.

## Local feed check on a signed Mac

Run this section twice: once for `arm64`, then once for `x64`. Do not run
`npm run release`. Do not tag, and do not publish. The update private key
stays in `~/.config/flowa/update-private.pem`. These commands do not print it.

1.2.2 calls `setFeedURL` for `maxkongerskov/flowa-electron` on every check, so
editing `app-update.yml` alone does not redirect it. The patch script removes
that call from the installed copy and writes a localhost `app-update.yml`.
The public key inside the installed 1.2.2 is left alone, because the zip
below is signed with the real key.

### 1. Install the published 1.2.2 dmg

```bash
ARCH=arm64   # second pass: x64
cd ~/flowa-electron
mkdir -p /tmp/flowa-122
gh release download v1.2.2 --repo maxkongerskov/flowa-electron \
  --pattern "Flowa-1.2.2-${ARCH}.dmg" --dir /tmp/flowa-122 --clobber
shasum -a 256 "/tmp/flowa-122/Flowa-1.2.2-${ARCH}.dmg"
```

The digests of the published files are:

- arm64: `sha256:984e90b91be92ecbec2512753ad70172e159a56b5ca6baecbd150a8724a7e275`
- x64: `sha256:266a435ef3b59fa4742d75bfa35f766ba6469affa769841a5994802a03f0ac84`

`shasum` must print that digest. Then install it over `/Applications/Flowa.app`:

```bash
hdiutil attach "/tmp/flowa-122/Flowa-1.2.2-${ARCH}.dmg"
rm -rf /Applications/Flowa.app
cp -R /Volumes/Flowa*/Flowa.app /Applications/Flowa.app
hdiutil detach /Volumes/Flowa*
```

On the second pass, move the updated arm64 app aside first
(`mv /Applications/Flowa.app /Applications/Flowa-arm64.app`) so the x64 dmg
can take `/Applications/Flowa.app`. An Apple Silicon Mac runs the x64 build
under Rosetta.

### 2. Build a slim 1.2.3 zip for this architecture

`package.json` is already `1.2.3`. This uses `electron-builder.yml`, so the
speech model is not inside the zip. Stage the usual Metal engine at
`resources/bin/darwin-${ARCH}/` (the same tree a release build uses). Quit
Flowa first.

```bash
npx electron-vite build
rm -rf "release-mac-${ARCH}"
npx electron-builder --config electron-builder.yml --mac dir --${ARCH} \
  -c.mac.identity=null -c.directories.output="release-mac-${ARCH}" --publish never
if [ "$ARCH" = arm64 ]; then APP="release-mac-${ARCH}/mac-arm64/Flowa.app"; else APP="release-mac-${ARCH}/mac/Flowa.app"; fi
node scripts/app-update-yml.mjs write "$APP/Contents/Resources"
SIGN_ID="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')"
IDENTITY="$SIGN_ID" NOTARY_PROFILE= bash scripts/sign-mac.sh "$APP"
ZIP="release-mac-${ARCH}/Flowa-1.2.3-${ARCH}-mac.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
```

`NOTARY_PROFILE=` skips notarization. ShipIt on this Mac accepts the Developer
ID signature. Do not submit the zip to Apple and do not upload it.

### 3. Serve the zip from localhost

```bash
mkdir -p "/tmp/flowa-feed-${ARCH}"
cp "$ZIP" "/tmp/flowa-feed-${ARCH}/"
FLOWA_UPDATE_KEY="$HOME/.config/flowa/update-private.pem" \
  node scripts/real-update-122.mjs serve-mac --dir "/tmp/flowa-feed-${ARCH}" --arch "$ARCH"
```

Leave that process running. It prints `feed http://127.0.0.1:<port>/`. The
private key is not printed. Use that URL in the next step.

### 4. Point the installed 1.2.2 at the feed

In another terminal, with `<port>` replaced by the printed port:

```bash
SIGN_ID="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')"
node scripts/patch-installed-feed.mjs \
  --resources /Applications/Flowa.app/Contents/Resources \
  --feed-url "http://127.0.0.1:<port>/" \
  --keep-public-key \
  --manual-download
IDENTITY="$SIGN_ID" NOTARY_PROFILE= bash scripts/sign-mac.sh /Applications/Flowa.app
```

`--keep-public-key` leaves the published key in place. `--manual-download`
leaves Download as a click. The re-sign is required because the asar edit
breaks the dmg's signature. `NOTARY_PROFILE=` again, so this modified 1.2.2
is not notarized.

### 5. Seed prefs and history

Seed `"flowa.microphone": "default"`. Home resets a saved id that is not among
the visible audio devices to `default` (the same code as in 1.2.2). A Mac has
devices, so an invented id such as `bridge-mic-122` is rewritten on first
paint and the assert fails even though the update kept the pref. CI runners
enumerate no devices, so that rewrite never runs there. `default` is the
value both places leave alone.

```bash
DIR="$HOME/Library/Application Support/Flowa-Electron"
mkdir -p "$DIR"
cat > "$DIR/prefs.json" <<'EOF'
{
  "flowa.language": "da",
  "flowa.microphone": "default",
  "flowa.colorScheme.dark": true,
  "flowa.onboardingComplete": true,
  "flowa.firstRunComplete": true,
  "flowa.maxDurationMinutes": 60,
  "flowa.shortcut": "Alt+Space",
  "flowa.hardware": "gpu",
  "flowa.speechModel": "whisper-turbo"
}
EOF
cat > "$DIR/recent.json" <<'EOF'
[
  {
    "date": "2026-10-20T12:00:00Z",
    "id": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    "targetAppName": "Notes",
    "text": "bridge-history-1.2.2-token"
  }
]
EOF
```

If this Mac already has real 1.2.2 prefs, copy that folder aside first and
put it back after the check. The sample above is the data this check tracks.

### 6. Check, download, quit, restart

```bash
/Applications/Flowa.app/Contents/MacOS/Flowa
```

The terminal must show `update available: 1.2.3`. Click Download. Flowa quits
and restarts. If the restarted process is not the one attached to this
terminal, quit it and run the same command again.

Pass means all of these are true:

- the log contains `[Flowa] version 1.2.3`
- the log contains `speech plan: backend=metal` (the Metal engine was staged;
  a CPU line means the engine was missing)
- `defaults read /Applications/Flowa.app/Contents/Info.plist CFBundleShortVersionString`
  prints `1.2.3`
- `"$DIR/prefs.json"` still has `"flowa.language": "da"`,
  `"flowa.microphone": "default"`, and `"flowa.hardware": "gpu"`
- `"$DIR/recent.json"` still contains `bridge-history-1.2.2-token`

```bash
python3 - <<'PY'
import json
from pathlib import Path
dir = Path.home() / "Library/Application Support/Flowa-Electron"
prefs = json.loads((dir / "prefs.json").read_text())
assert prefs["flowa.language"] == "da"
assert prefs["flowa.microphone"] == "default"
assert prefs["flowa.hardware"] == "gpu"
recent = json.loads((dir / "recent.json").read_text())
assert any(item.get("text") == "bridge-history-1.2.2-token" for item in recent)
print("mac user data ok")
PY
```

Stop the feed process with Ctrl-C. Do not upload `/tmp/flowa-feed-${ARCH}`.
Repeat from step 1 with `ARCH=x64`.

## Rollback

electron-updater does not install an older version. Pulling 1.2.3 only stops
people who are still on 1.2.2 from being offered it. People already running
1.2.3 stay there until a newer version is published to the same repo.

### Pull a bad 1.2.3

Do this on `maxkongerskov/flowa-electron` only. Drafting is reversible.
Deleting the release removes its `latest*.yml` with it. Either way, 1.2.2
has to be Latest again, or 1.2.2 installs keep reading the bad feed.

Draft, and drop the feed files off the draft:

```bash
gh release edit v1.2.3 --repo maxkongerskov/flowa-electron --draft --latest=false
gh release delete-asset v1.2.3 latest-mac.yml --repo maxkongerskov/flowa-electron --yes
gh release delete-asset v1.2.3 latest.yml --repo maxkongerskov/flowa-electron --yes
gh release delete-asset v1.2.3 latest-linux.yml --repo maxkongerskov/flowa-electron --yes
gh release edit v1.2.2 --repo maxkongerskov/flowa-electron --latest
```

Or delete the release. This also deletes `latest*.yml`:

```bash
gh release delete v1.2.3 --repo maxkongerskov/flowa-electron --yes
gh release edit v1.2.2 --repo maxkongerskov/flowa-electron --latest
```

Leave the `v1.2.3` git tag in place if a corrected build will reuse that
version number. Delete the tag only when 1.2.3 will not be published again.

After this, a 1.2.2 install checks `flowa-electron`, finds 1.2.2 as Latest,
and stays put.

### People already on 1.2.3

They do not return to 1.2.2. Their `app-update.yml` points at
`flowa-electron`, the same repo 1.2.2 reads. Ship the fix as 1.2.4:

```bash
npm run release -- 1.2.4
```

`publish-release.sh` uploads 1.2.4 to `flowa-electron` only. Both 1.2.2 and
1.2.3 installs are offered 1.2.4, because there is one feed. Replacing the
1.2.3 files instead of publishing 1.2.4 updates anyone still on 1.2.2. It
does not update anyone already running 1.2.3, because the version did not
change. Those installs need 1.2.4.
