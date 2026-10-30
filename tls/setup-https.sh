#!/bin/zsh
# Optional: turns on the secure (https) address for Window Remote.
# Before this works, HTTPS certificates must be enabled for your tailnet (Tailscale admin console,
# DNS page, "Enable HTTPS"). Note: Tailscale certificates are public records, so this Mac's
# Tailscale name (like my-mac.tailXXXX.ts.net) becomes visible in public certificate logs.
# Nothing else does, and the address still only works from inside your tailnet.
set -e
TS=$(for p in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [[ -x "$p" ]] && { echo "$p"; break; }; done)
[[ -n "$TS" ]] || { echo "Tailscale was not found. Install it from https://tailscale.com/download first."; exit 1; }
DIR="$HOME/Library/Application Support/Window Remote/tls"
NAME=$("$TS" status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
mkdir -p "$DIR"; chmod 700 "$DIR"
"$TS" cert --cert-file "$DIR/cert.pem" --key-file "$DIR/key.pem" "$NAME"
chmod 600 "$DIR/key.pem"
echo "Done. The secure address is https://$NAME:8764/ (the server picks it up within a few seconds)."
