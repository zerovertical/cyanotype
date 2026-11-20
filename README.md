# Cyanotype

Chat between phones with no servers and no internet. Two phones pair once by
scanning each other's QR codes, then talk directly over whatever local network
they share — home wifi, or one phone's hotspot.

- One-to-one and group chats, voice calls, photos, files and voice notes
- Live location sharing for ten minutes at a time
- Messages carried between contacts when the person you want is out of range,
  sealed so the phone carrying them can neither read nor change them
- Reconnect without a camera by swapping short typed codes
- Everything stored on the phone, encrypted

It runs as a web page in any modern browser, and as an Android app. The Android
app is the same page inside a thin wrapper that adds what a browser cannot do:
staying connected while the phone is locked, real notifications, and saving
received files.

---

## What is in this repo

    web/                    the app: index.html (page + styles), app.js, boot.js
                            (startup errors), vendor.js (QR libraries), sw.js, icons
    android/                the Android wrapper (Capacitor project)
      app/src/main/java/net/cyanotype/app/
        MainActivity.java     starts the app, handles the back gesture
        ForegroundPlugin.java notifications, file saving, keeping alive
        LinkService.java      the "Cyanotype is connected" background service
    probe/index.html        a test page for checking the phone keeps the app running
    tools/make-signing-key.mjs  makes the key releases are signed with
    tests/                  end-to-end and security tests (npm test)
    .github/workflows/android.yml  builds the APK on GitHub
    RELEASING.md            how to publish a new version
    CHANGELOG.md            what changed in each version

`web/app.js` is a single bundled file. If you keep the original source
modules (crypto.js, net.js, store.js, app.js and so on) somewhere else, edit
those and rebuild rather than editing the bundle, or the next build will undo
the change.

---

## Running the browser version

The page must be served over HTTPS (or from `localhost`), or the camera and the
direct connection are blocked. GitHub Pages works, but its simple
"deploy from a branch" mode only publishes the repo root or a `docs/` folder,
not `web/`, so hosting it there needs a small Pages workflow. To try it on your
computer, run `npx serve web` and open the `localhost` address it prints.

**Give it a site of its own.** Browsers keep storage per site, not per folder.
At `yourname.github.io/cyanotype`, every other project page under
`yourname.github.io` could read Cyanotype's keys and messages. Use a custom
subdomain (for example `chat.yourdomain.com`) or a dedicated
`something.github.io` account. Settings → Diagnostics → *storage isolation*
says whether the copy you are using is shared.

Before blaming the app for a connection problem, check that your two phones can
reach each other at all. Plenty of guest networks and some ISP routers block
devices on the same wifi from talking to each other, and that looks exactly like
a bug. On a hotspot, pair with the phone that is *sharing* it.

In a browser, notifications only arrive while the page is still open in the
background. Android closes background browser tabs fairly quickly, which is the
reason the Android app exists.

---

## Building the Android app

Nothing needs to be installed on your computer apart from Node and Git — the
build runs on GitHub.

1. Push to `main`.
2. On GitHub: **Actions** → the latest run → **Artifacts** → `cyanotype-apk`.
3. Unzip it and copy the APK to the phone, then open it. Android asks you to
   allow installs from that source the first time.

Both phones need to run the same version for pairing to work reliably.

**Set up signing before you rely on updates.** Without it, every build is signed
with a different throwaway key and a new APK will not install over the old one
— you have to uninstall first, which deletes all chats and contacts. Setting it
up takes about ten minutes and is described in [RELEASING.md](RELEASING.md).

---

## What the Android app adds

**Staying connected while locked.** While at least one link is live, the app
runs a background service and shows a quiet "Cyanotype is connected —
Linked to 2 people" notification. Android requires that notification; it cannot
be hidden. When the last link has been gone for 90 seconds the service stops
and the notification goes away.

**Keeping the link up with the screen off.** While the service runs it also
stops Wi-Fi power-saving and keeps the processor awake, so the link's
keep-alive checks keep getting answered. Android only honours this in deep
sleep if Cyanotype is allowed to skip battery optimisation, so the first time
a link opens the app asks once. You can change it later in Settings →
*Staying connected*.

**Reconnecting by itself on the same Wi-Fi.** If a link drops, the phones find
each other again on the local network and reconnect without codes. Each phone
announces itself under a random name, and asks the others about the contacts it
is missing using one-off tags that only a phone holding the same pairing secret
can recognise. Both phones prove they hold that secret before either sends an
offer, and the offer is sealed with the pairing key, so a stranger on the same
Wi-Fi learns only that a Cyanotype phone is there. The app always looks while
it is open. After a link drops it keeps looking in the background for 30
minutes by default (Settings → *Staying connected*: Off, 30 minutes or Until
found), and the notification says "Looking for a contact on this Wi-Fi" while
it does. Some routers keep devices apart ("client isolation" or a guest
network); there the phones cannot see each other and you fall back to codes.

**Notifications.** New messages, files, location shares and missed calls show
as normal phone notifications while the app is in the background. Each chat has
one notification that updates ("Sam (3 new)") rather than piling up. Messages
are marked private, so if the phone is set to hide sensitive notification
content on the lock screen, only "New message" shows until it is unlocked.
Incoming calls ring through a separate, louder channel. All of these can be
adjusted in Android Settings → Apps → Cyanotype → Notifications.

**Saving files.** Received files, photos and voice notes save to
`Downloads/Cyanotype` (on Android 9 and older, to the app's own folder).

**Back gesture.** Goes back through the app's screens. On the home screen it
sends the app to the background instead of closing it, so links stay up.

A notification can only appear while the app is still running. There is no
server to wake it up, so if Android closes the app anyway — some phone brands,
notably Samsung and Xiaomi, are aggressive about this — nothing arrives until you
open it again. If that happens, set Cyanotype's battery usage to
"Unrestricted" in Android Settings → Apps → Cyanotype → Battery.

---

## Contacts and clearing up

- **Add a contact**: Contacts tab → *+ Add a contact*. Contacts are only ever
  added by scanning codes in person, so nobody can add themselves remotely.
- **Contact details, rename, delete**: tap a contact. Deleting removes their key
  from this phone; they can no longer reach you until you pair again in person.
- **Chat options**: the ⋯ button in a chat, or press and hold a chat in the
  list — rename, clear messages, delete the chat or group.
- **Single messages**: press and hold a message to react to it, or to copy,
  save or delete it. Tap a reaction under a message to see who reacted.
- **Old messages**: Settings → *Keep messages for* deletes older messages
  automatically (30 days, 90 days or a year), or *Delete older messages now*.

All deleting is local to the phone you do it on. The other person's copy is not
touched.

---

## Testing that the app stays alive while locked

Two separate things can stop the app in the background, and they need
different fixes.

**Part A — is the code still running?** Temporarily copy `probe/index.html`
over `web/index.html`, push, install that build, open it, lock the phone, wait
five minutes and unlock. Then put the real `web/index.html` back.

| Verdict | Meaning | What to do |
|---|---|---|
| no throttling seen | the page ran normally throughout | nothing — best case |
| throttled, still alive | timers stretched, still running | raise `STALE` in `web/app.js` well above the gap you saw |
| frozen for N seconds | Android stopped the app | check the "connected" notification was showing |

Note the probe has no links, so the background service does not run during it.
To test the service, use Part B.

**Part B — does a real link survive?** Pair two phones. Lock one for five
minutes. Unlock.

- Still connected, messages waiting → working.
- Reconnected by itself → the link dropped, but the phones found each other
  again on the Wi-Fi (or through another contact).
- Asking for a code → neither could reach the other: different networks, a
  router that keeps devices apart, or background looking switched off or
  timed out with both apps in the background. Opening the app on both phones
  should reconnect them.

Chromium, the engine inside the app, slows down pages it thinks are hidden and
after about five minutes may stop them altogether, even with the service
running. The wrapper works around this by telling the engine the page is still
visible while a link is live. That is a well-known workaround rather than an
official feature, so test it on your own phones. If Part A passes but Part B
fails, the connection itself is being paused, which points at moving the
connection into native Android code.

Check Settings → Battery afterwards: holding a link open costs real power.

---

## Tests

    npm install
    npm test

This runs three suites in your installed Chrome, using simulated phones that
pair over a real local connection:

- `tests/app.test.mjs` — pairing, messaging, notifications, files, contacts,
  deleting, settings, groups, the interface.
- `tests/security.test.mjs` — four simulated phones, one of them hostile,
  attack each security fix in turn: forged senders, group takeovers, fake
  delivery notes, oversized files, a stranger hanging up your call, and more.
- `tests/lan.test.mjs` — reconnecting on the same Wi-Fi. The script plays the
  part of Android's network discovery and sockets. It drops links and checks
  the phones find each other again, that a queued message then goes out, that
  a stranger on the network (made-up probes, replayed probes and offers, junk
  lines) gets nothing, the battery question, and the background settings.

The Android side of discovery (`LanLink.java`) can only be tested on real
phones: pair two, turn one's Wi-Fi off and on, and watch them reconnect.

Set `CHROME_PATH` if Chrome is not installed in the usual place.

---

## Not done yet

- **Reconnecting across different networks** without a contact in between or
  codes. Same-Wi-Fi reconnection is automatic from 1.4.0.
- **Automatic reconnection in the browser version.** A web page cannot look
  for other phones on the network, so only the Android app does this.
- **Removing someone from a group.** You can delete a group from your own phone,
  but the host cannot yet remove a member.
- **Update checks.** The app does not tell you when a new release is out. See
  [RELEASING.md](RELEASING.md) for how to update phones by hand.
