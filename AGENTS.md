# Window Remote: notes for coding agents

This repository is **public**. Never add personal information: no real names, email addresses,
home-folder paths, Tailscale addresses or machine names, client or business details. Commits use
the `thoughtcrimegpt` noreply identity. Run the leak scan below before every commit.

- Layout and how it fits together: see README.md, "How it is built".
- The background helper app (`launcher/`) is what macOS grants Screen Recording and Accessibility
  to. `launcher/build-launcher.sh` builds it only once (pass `--force` to rebuild, which makes the
  user grant both permissions again). Everything else (`core/build-core.sh`, `mac-app/build-app.sh`,
  `server/`) can be rebuilt any time; `pkill -HUP -x WindowRemote` restarts the helper and server.
- The phone app (`server/public/`) is read fresh on each request. When its file list changes,
  update `SHELL` in `server/public/sw.js` and bump `CACHE`.
- Checks: `node test/smoke.mjs` (no helper or Tailscale needed). With the remote running:
  `node test/ws-cmd.mjs '{"t":"list"}'` sends one message as a local test device
  (`node test/test-key.mjs --remove` revokes that test key afterwards).
- Leak scan before committing:
  `git grep -n -i -E "/Users/|@gmail|100\.[0-9]+\.[0-9]+\.[0-9]+|\.ts\.net"` should only show the
  documented placeholders (`100.x.y.z`, `<your-mac>.<tailnet>.ts.net`, `my-mac.tailXXXX.ts.net`).
