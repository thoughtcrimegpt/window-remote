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

- A Mac with **macOS 14 (Sonoma) or newer**.
- An iPhone (any modern phone browser works, but it is designed for iPhone Safari).
- **Tailscale** (free) on both, signed in to the **same Tailscale account**: [tailscale.com/download](https://tailscale.com/download).
- On the Mac: **Node.js 20 or newer** ([nodejs.org](https://nodejs.org), or `brew install node`) and Apple's command line tools (`xcode-select --install`).

## Install (on the Mac)

1. Download this repository (green **Code** button, **Download ZIP**, then unzip it), or clone it:

   ```bash
   git clone https://github.com/thoughtcrimegpt/window-remote.git
   ```

2. In Terminal, go into the folder and run the installer:

   ```bash
   cd window-remote
   ./install.sh
   ```

   It builds everything on your Mac (nothing is downloaded except the two web-server packages from npm), starts the remote, and sets it to start at login. The **Window Remote** window opens when it is done.

3. Grant the two permissions the window asks for, in System Settings, Privacy & Security:
   - **Screen Recording**, so your phone can see the screen.
   - **Accessibility**, so taps and typing from your phone reach the Mac.

   Turn on the switch next to **Window Remote** in each list.

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

Get the new version (`git pull`, or download the ZIP again into the same folder) and run `./install.sh` again. Your permissions and paired phones are kept: the background helper that holds the permissions is built only once.

If you move the folder, run `./install.sh` again from its new place.

## Uninstall

```bash
./launchd/uninstall.sh
launchctl bootout gui/$(id -u)/local.window-remote
```

Then delete `~/Applications/Window Remote.app`, the folder `~/Library/Application Support/Window Remote` (helper, paired phones, settings) and `~/Library/Logs/Window Remote`, and remove Window Remote from Screen Recording and Accessibility in System Settings.

## Troubleshooting

- **"Mac offline" on the phone:** Is Tailscale on in the phone and the Mac? Is the Mac awake? Try the address from the Window Remote window in Safari.
- **"This device is not on your Tailscale account":** the phone must be signed in to the same Tailscale account as the Mac.
- **Black or frozen picture:** Screen Recording permission is off, or the Mac screen is asleep. Open the Window Remote app on the Mac; it shows what is missing.
- **Taps do nothing:** Accessibility permission is off.
- **Logs:** `~/Library/Logs/Window Remote/` (`server.log`, `core.log`, `launcher.log`).

## How it is built

- `core/`: the Swift helper (`bin/wr-core`): ScreenCaptureKit capture, VideoToolbox H.264 encoding, mouse and keyboard input, and the "Needs You" window reader.
- `server/`: the Node web server the phone talks to (pairing, WebRTC video via [werift](https://github.com/shinyoshiaki/werift-webrtc), the phone app in `server/public/`).
- `launcher/`: the small background app macOS attaches the permissions to. It runs the helper and the server and restarts either one if it stops.
- `mac-app/`: the Window Remote window (SwiftUI).
- `launchd/`: the login item. `tls/`: the optional https setup.
- `test/smoke.mjs`: checks the server's pairing and security rules without a Mac helper or Tailscale (`node test/smoke.mjs`).

## License

MIT. See [LICENSE](LICENSE).
