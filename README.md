# Window Remote

Use your Mac from your iPhone, one window at a time, from anywhere.

Open the Remote app on your phone and you see every window that is open on your Mac, with live thumbnails. Tap one and it fills your phone screen as live video. Tap to click, swipe to scroll, pinch to zoom, and type or dictate into it. It works on wifi or cellular, through [Tailscale](https://tailscale.com), so your Mac is never put on the public internet.

## What it does

- **Window list:** every open window with a live picture, plus each whole screen and the minimized windows. Long-press a window to bring it to the front on the Mac.
- **Snap into one window:** tap a window and only that window streams to your phone, sharp and fast (hardware H.264 video over WebRTC). Switch windows from the title at the top.
- **Fit to iPhone:** optionally reshapes the Mac window to your phone's shape while you watch, then puts it back when you leave.
- **Touch controls built for a phone:** tap to click (near misses land on the button), swipe to scroll, pinch to zoom, touch and hold for a magnifier and exact aim, two-finger tap to right click.
- **Message bar:** type or dictate on the phone, Send puts the text in the Mac's text box (and presses Return, if you want). Special keys: esc, tab, arrows, ⌘ ⇧ ⌥ ⌃, Copy, Paste, Undo.
- **Needs You:** windows that are waiting on you (a permission prompt in Claude Code, Codex, a terminal, or a macOS dialog) show at the top with their answer buttons, so one tap answers them.
- **Weak connections:** picture quality adjusts by itself, and a "Basic video" mode sends small still pictures when video cannot get through.
- **Mac status:** "Mac is locked", "Mac screen is asleep" (with a Wake button), "Mac offline" and "Reconnecting" instead of a blank screen.

## What you need

- A Mac with **macOS 14 (Sonoma) or newer**. Both Apple silicon and Intel Macs work (tested on both).
- An iPhone (any modern phone browser works, but it is designed for iPhone Safari).
- **Tailscale** (free) on both, signed in to the **same Tailscale account**: [tailscale.com/download](https://tailscale.com/download).
- On the Mac: **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), or `brew install node`) and Apple's command line tools (`xcode-select --install`).
- On an Intel Mac, Homebrew now warns that it no longer supports Intel, so the installers from [nodejs.org](https://nodejs.org) and [tailscale.com](https://tailscale.com/download) are the easier choice.

## Install (on the Mac)

1. Download this repository (green **Code** button, **Download ZIP**, then unzip it), or clone it. Your home folder is a good place (`~/window-remote`), but anywhere works: the installer copies what runs in the background into its own folder, so the download can sit in Documents, Downloads or iCloud Drive too.

   ```bash
   git clone https://github.com/thoughtcrimegpt/window-remote.git ~/window-remote
   ```

2. In Terminal, go into the folder and run the installer:

   ```bash
   cd ~/window-remote
   ./install.sh
   ```

   (Downloaded the ZIP instead? Right-click the unzipped folder, then Services, then **New Terminal at Folder**, and type `./install.sh`.)

   It builds everything on your Mac (nothing is downloaded except the two web-server packages from npm), starts the remote, and sets it to start at login. The **Window Remote** window opens when it is done. If Tailscale is missing, signed out or off, a red box at the end says so.

3. Grant the two permissions. macOS asks for them by itself; you can also click **Open Settings** in the Window Remote window. In System Settings, Privacy & Security:
   - **Screen Recording**, so your phone can see the screen.
   - **Accessibility**, so taps and typing from your phone reach the Mac.

   In each list, turn on the switch next to **Window Remote Helper**. That is the background part of Window Remote, and the only one that needs the permissions. (Installed before this name was added? Then it is listed as **Window Remote**, with the same icon.)

   - **Not in the list?** Click **Show Helper in Finder** in the Window Remote window and drag the helper into the list. Or click **+** under the list, press ⌘⇧G, paste `~/Library/Application Support/Window Remote/Window Remote Helper.app` and click Open.
   - **After turning on Screen Recording,** choose **Quit & Reopen** if macOS offers it, or click **Restart Helper** in the Window Remote window.

## Set up your iPhone

1. Turn Tailscale on in the iPhone.
2. Scan the QR code in the Window Remote window on your Mac (or type the address it shows, like `http://100.x.y.z:8765/`) and open it in **Safari**.
3. Tap Share, then **Add to Home Screen**. Open **Remote** from your Home Screen.
4. Tap **Show a Code on My Mac** and type the 6-digit code your Mac shows. You only do this once per phone.

That's it. Open Remote, tap a window.

## How it keeps your Mac safe

- The server listens only on `127.0.0.1` and your Mac's Tailscale address. No port forwarding, no public tunnels, no outside servers. Video goes straight from your Mac to your phone over Tailscale.
- Every connection must come from a device signed in to **your own Tailscale account** (checked with `tailscale whois`). Devices shared into your tailnet by other people are refused.
- Every device must also be **paired once** with a code shown only on the Mac (6 digits, 5 minutes, one use, 5 tries). The phone keeps a long random key; the Mac stores only a fingerprint of it, tied to that Tailscale device, so a copied key is useless elsewhere.
- Requests must use the Mac's own address (blocks DNS tricks), and every change needs the app's own header from the same page, so other websites cannot press buttons.
- The Mac's clipboard is only offered to the phone right after you press Copy from the phone (a clipboard can hold a just-copied password).
- From the menu bar icon on the Mac: **Disconnect phone now** (pauses the remote for 10 minutes) and **Forget paired phones** (every phone must pair again).

## Everyday use

- **Menu bar:** a phone icon shows whether a phone is connected, with Pair an iPhone, Disconnect phone now, and Forget paired phones.
- **Window Remote app** (in ~/Applications): status, permissions, the QR code, paired phones, and the "Start when I log in" switch.
- **The Mac must be awake and unlocked** for you to see windows. macOS only accepts a password, Touch ID or an Apple Watch at its lock screen, so the phone shows "Mac is locked" until you unlock it at the Mac. In System Settings, Battery or Energy, setting the Mac to not sleep while plugged in helps.

## Optional: secure address (https)

With HTTPS turned on for your tailnet (Tailscale admin console, DNS page, Enable HTTPS), run:

```bash
./tls/setup-https.sh
```

The app then also answers at `https://<your-mac>.<tailnet>.ts.net:8764/`. On that address the phone keeps a copy of the app, so opening it while the Mac is unreachable shows "Mac offline" instead of a Safari error, and the Home Screen icon can show the "Needs You" count. Note: Tailscale certificates are public records, so your Mac's Tailscale name becomes visible in public certificate logs. Pair the phone once more on the new address.

## Updating

Get the new version (`git pull`, or download the ZIP again) and run `./install.sh` again. Your permissions and paired phones are kept: the background helper that holds the permissions is built only once.

Moving or deleting the download folder does not stop the remote, since it runs from its own copy. Run `./install.sh` from wherever the new version is.

## Uninstall

```bash
./uninstall.sh
```

It lists what it will remove and asks first. It stops the remote, quits the app, and removes the login item, `~/Applications/Window Remote.app`, `~/Library/Application Support/Window Remote` (helper, paired phones, settings), `~/Library/Logs/Window Remote` and the Screen Recording and Accessibility entries. It never touches the download folder; delete that yourself if you like. `./uninstall.sh --dry-run` only shows what it would do.

To only stop it from starting at login, turn off "Start when I log in" in the Window Remote window.

## Troubleshooting

- **"Mac offline" on the phone:** Is Tailscale on in the phone and the Mac? Is the Mac awake? Try the address from the Window Remote window in Safari.
- **"This device is not on your Tailscale account":** the phone must be signed in to the same Tailscale account as the Mac.
- **Black or frozen picture:** Screen Recording permission is off, or the Mac screen is asleep. Open the Window Remote app on the Mac; it shows what is missing.
- **Taps do nothing:** Accessibility permission is off.
- **The Window Remote window says the remote is not answering** (or `http://127.0.0.1:8765/` does not load): macOS is probably waiting for you to answer a question, such as access to a folder. Look for a dialog hidden behind other windows. If there is none, click **Restart Helper**, and if it stays stuck, run `./install.sh` again.
- **Window Remote Helper is not in the Screen Recording list:** open the Window Remote window (it asks macOS to add it), or add it by hand: **Show Helper in Finder**, then drag it into the list. Turning the switch on and then choosing Quit & Reopen (or Restart Helper) finishes it.
- **Logs:** `~/Library/Logs/Window Remote/` (`server.log`, `core.log`, `launcher.log`, `app.log`).

## How it is built

- `core/`: the Swift helper (`bin/wr-core`): ScreenCaptureKit capture, VideoToolbox H.264 encoding, mouse and keyboard input, and the "Needs You" window reader.
- `server/`: the Node web server the phone talks to (pairing, WebRTC video via [werift](https://github.com/shinyoshiaki/werift-webrtc), the phone app in `server/public/`).
- `launcher/`: the small background app ("Window Remote Helper") macOS attaches the permissions to. It runs the helper and the server and restarts either one if it stops. It runs them from the copy `install.sh` makes in `~/Library/Application Support/Window Remote/runtime`, never from the download folder.
- `mac-app/`: the Window Remote window (SwiftUI).
- `launchd/`: the login item. `tls/`: the optional https setup.
- `test/smoke.mjs`: checks the server's pairing and security rules without a Mac helper or Tailscale, and the uninstaller in dry-run mode (`node test/smoke.mjs`).

## License

MIT. See [LICENSE](LICENSE).
