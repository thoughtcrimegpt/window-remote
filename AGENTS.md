# Window Remote: notes for coding agents

This repository is **public**. Never add personal information: no real names, email addresses,
home-folder paths, Tailscale addresses or machine names, client or business details. Commits use
the `thoughtcrimegpt` noreply identity. Run the leak scan below before every commit.

- Layout and how it fits together: see README.md, "How it is built".
- The background helper app (`launcher/`) is what macOS grants Screen Recording and Accessibility
  to. `launcher/build-launcher.sh` builds it only once (pass `--force` to rebuild, which makes the
  user grant both permissions again; it is also why helpers built before the "Window Remote
  Helper" name keep the plain "Window Remote" name). Everything else (`core/`, `mac-app/`,
  `server/`) can be rebuilt any time.
- The helper never runs from the download folder: `install.sh` copies `server/`, `bin/wr-core`
  and `launchd/` to `~/Library/Application Support/Window Remote/runtime` (macOS can block
  programs reading Documents, Desktop, Downloads or iCloud Drive behind a hidden prompt). So after
  changing code, run `./install.sh` to apply it; `pkill -HUP -x WindowRemote` only restarts.
- The phone app (`server/public/`) is read fresh from the runtime copy on each request. When its
  file list changes, update `SHELL` in `server/public/sw.js` and bump `CACHE`.
- `./uninstall.sh` removes everything but the download folder (`--dry-run` lists it; the smoke
  test runs that in a pretend home folder).
- Checks: `node test/smoke.mjs` (no helper or Tailscale needed). With the remote running:
  `node test/ws-cmd.mjs '{"t":"list"}'` sends one message as a local test device
  (`node test/test-key.mjs --remove` revokes that test key afterwards).
- Leak scan before committing:
  `git grep -n -i -E "/Users/|@gmail|100\.[0-9]+\.[0-9]+\.[0-9]+|\.ts\.net"` should only show the
  documented placeholders (`100.x.y.z`, `<your-mac>.<tailnet>.ts.net`, `my-mac.tailXXXX.ts.net`).
