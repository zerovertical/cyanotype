# Releasing a new version

There are two parts. The first you do once, ever. The second you repeat for
each release.

---

## Part 1 — one-time setup: the signing key

Android only lets a new APK install over an existing one if both were signed
with the same key. GitHub's build machines make a fresh throwaway key every
time, so until you do this, every update means uninstalling first — and
uninstalling deletes all chats and contacts on that phone.

You make the key once on your own computer and give GitHub a copy as a secret.
It never goes into the repo.

**1. Make the key.** In PowerShell, inside the repo folder:

    npm install
    npm run signing-key

This creates a `signing` folder (git ignores it) with two files:

- `cyanotype-release.p12` — the key itself
- `github-secrets.txt` — four values to give GitHub

**2. Give GitHub the four values.** On GitHub, open your repo, then
**Settings → Secrets and variables → Actions → New repository secret**. Add
each of these, copying the name and value from `github-secrets.txt`:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the very long line — copy all of it |
| `ANDROID_KEYSTORE_PASSWORD` | the password |
| `ANDROID_KEY_ALIAS` | `cyanotype` |
| `ANDROID_KEY_PASSWORD` | the same password again |

**3. Back up the key, then delete the secrets file.** Copy
`cyanotype-release.p12` and the password somewhere safe that is not GitHub — a
password manager is ideal. Then delete `github-secrets.txt`.

> **If you lose the key**, no phone can update to a new version without
> uninstalling first. Treat it like the master key to the app.

**4. Check it worked.** Push anything to `main` and open the run under
**Actions**. The "Unpack the signing key" step should not show a yellow
warning, and the APK in the Artifacts section is now signed with your key.

**5. One last uninstall.** Phones that already have a test build were signed
with an old throwaway key, so they must uninstall it once before installing the
first signed build. That deletes their chats and contacts, so re-pair
afterwards. From then on, every update installs over the top and keeps
everything.

---

## Part 2 — each release

**1. Note what changed.** Add a section to the top of `CHANGELOG.md`.

**2. Push to `main` and try the test build.** Wait for the Actions run to go
green, download the APK from its Artifacts, and try it on a phone. Pair two
phones and send a message at the very least.

**3. Tag the release.** Pick the next version number. A common habit is to bump
the last number for fixes (1.1.0 → 1.1.1), the middle one for new features
(1.1.1 → 1.2.0), and the first for big changes. Then:

    git tag v1.2.0
    git push origin v1.2.0

The `v` at the front matters: that is what tells the workflow this is a
release.

**4. Wait for the build.** The workflow builds the APK, signs it, and creates a
page under **Releases** (right-hand side of the repo's front page) called
"Cyanotype v1.2.0" with `cyanotype-1.2.0.apk` attached and a list of the commits
since the last release. You can edit that page afterwards to paste in the
changelog section.

If signing is not set up, the release step stops with a red error rather than
publishing an APK that cannot update anyone.

**5. Update the phones.** On each phone, open the Releases page in the browser,
download the APK and open it. Android shows **Update** rather than **Install**,
and everything on the phone is kept. Update both phones before pairing new
contacts, so they run the same version.

---

## The version numbers

You never edit version numbers by hand.

- **The name** people see (1.2.0) comes from the tag. Test builds from `main`
  are named after the commit instead, like `dev-3f2a91c`.
- **The internal number** Android uses to decide whether something is an
  update comes from the build's run number on GitHub, which only ever goes up.

That means a test build made after a release counts as newer than it, so a
phone can move freely between test builds and releases.

---

## If something goes wrong

**The release build failed.** Open the run under Actions and click the red
step to see why. Fix it, push the fix to `main`, then move the tag to the new
commit:

    git tag -d v1.2.0
    git push origin :refs/tags/v1.2.0
    git tag v1.2.0
    git push origin v1.2.0

If a Release page was already created, delete it on GitHub first.

**"App not installed" on the phone.** The APK was signed with a different key
from the copy already installed — usually an old test build from before signing
was set up. Uninstall and install again (this deletes that phone's chats).

**The yellow "No signing key" warning still appears.** One of the four secrets
is missing or misnamed. The names must match exactly, including capitals.
