# Changelog

## 1.2.0

### A friendlier look
- Rounded corners throughout: buttons, cards, lists, message bubbles, the QR
  code, the camera view and the reconnect code.
- Menus slide up from the bottom of the screen on phones, within thumb reach,
  and float in the middle on wider screens.
- Plain text in place of the all-caps monospace labels. Codes and fingerprints
  keep the fixed-width font so they are easy to read out.
- Proper icons for call, reconnect, add person, options, attach, voice note and
  send, replacing the old symbol characters.
- Round, coloured avatars with initials. Each person keeps their colour, even
  after a rename, and a small dot on the avatar shows who is online.
- The main action on each screen is a filled button; the blueprint grid
  background is replaced by a soft gradient.
- The status at the top reads in plain words ("Ready", "Connected",
  "Waiting for them…"). The phone's ID and offline status moved to Settings.

### Easier to use
- **Unread counts** on each chat and on the Chats tab, cleared when you open
  the chat.
- **Messages grouped by day** under "Today", "Yesterday" or the date, with just
  the time on each message.
- **Reading back is not interrupted.** If you have scrolled up, new messages no
  longer yank you to the bottom; a "New messages ↓" button appears instead.
- **The message box stays at the bottom** of the screen in long chats; before,
  the whole page scrolled and pushed it out of view.
- **A tidier message box**: one + button for photos, files and location, a box
  that grows for longer messages, and a round button that is the microphone
  until you type, then becomes send.
- **Tap the chat's name** to see the contact's details (or the group's options).
- **New group** and **Reconnect** use the app's own menus instead of the
  browser's pop-ups. Reconnecting used to ask OK/Cancel, where Cancel meant
  "they already read me their code"; it now offers two clearly named choices.
- A one-time tip about pressing and holding a message.
- Friendlier empty screens for chats and contacts. The hotspot tip only shows
  until you have a chat, and appears on the pairing screen where it matters.
- A group with nobody else in it says "Just you so far" instead of "1 people".

## 1.1.0

### New
- **Notifications in the Android app.** New messages, files, group messages,
  relayed messages, location shares and missed calls now show as phone
  notifications while the app is in the background. One notification per
  chat, updated as more arrive. Marked private, so phones set to hide
  sensitive content on the lock screen show only "New message" there.
  Incoming calls ring through their own louder channel. Tapping a notification
  opens that chat.
- **Notifications in the browser version** now cover ordinary messages too
  (before, only calls, location shares and relayed messages did), and tapping
  one opens the chat.
- **Contacts**: tap a contact to see their key fingerprint and status, start a
  chat, rename them, or delete them. *+ Add a contact* explains in-person
  pairing.
- **Chat options** (⋯ button, or press and hold a chat in the list): rename,
  clear messages, delete chat or group.
- **Press and hold a message** to copy its text, save its attachment, or delete
  it from this phone. Deleting a message that has not been sent yet stops it
  being sent.
- **Settings** screen: notification status, automatic deletion of messages
  older than 30 days, 90 days or a year, a one-off "delete older messages
  now", and a storage summary. Diagnostics moved here.
- **Signed releases**: a one-time signing key and a release workflow, so updates
  install over the previous version instead of needing an uninstall.

### Fixed
- Saving received files did nothing in the Android app. Files now go to
  `Downloads/Cyanotype`.
- The "Cyanotype is connected" notification showed from the moment the app
  opened, even with nobody connected. It now appears only while a link is live
  and goes 90 seconds after the last one ends.
- The battery-costly keep-visible workaround ran every time the app was
  backgrounded. It now runs only while a link is live.
- If Android stopped the app, the service could restart on its own and show
  "connected" with nothing connected. It no longer restarts itself, and it
  stops when the app is swiped away.
- The back gesture on the home screen closed the app and dropped every link. It
  now sends the app to the background, and elsewhere it steps back through the
  app's screens.
- In the Android app, messages could be marked as read (blue ticks) while the
  phone was locked, because the keep-visible workaround made the page think it
  was on screen. The page now asks Android whether the app is really in front.
- An empty pop-up message box peeked out from the bottom of the screen.
- Browser notifications could wait forever if the service worker had failed to
  register.

### Under the hood
- Updated Capacitor to 7.6.10, which fixes a critical security advisory
  (GHSA-rvm3-566m-v7fv) in the version previously locked.
- Notification icons drawn for the status bar instead of the Bluetooth icon.
- Removed the unused example tests from the Capacitor template.
- Added the timer probe, README and release guide to the repo.

## 1.0.0
- Android wrapper with a foreground service to keep links alive while locked.
