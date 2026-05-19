#!/usr/bin/env bash
#
# arclo-chat installer.
#
#   curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/arclo-chat/main/install.sh | bash
#
# Clones the repo into ~/arclo-chat (override with ARCLO_DIR) and installs
# dependencies. Run `npm start` afterwards to launch the server.
#
set -euo pipefail

REPO_URL="https://github.com/kaiden-stowell/arclo-chat.git"
TARGET_DIR="${ARCLO_DIR:-$HOME/arclo-chat}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || err "git is required but not installed."
command -v node >/dev/null 2>&1 || err "Node.js 18+ is required but not installed."
command -v npm  >/dev/null 2>&1 || err "npm is required but not installed."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || err "Node.js 18+ required (found $(node -v))."

if [ -d "$TARGET_DIR/.git" ]; then
  info "Updating existing arclo-chat in $TARGET_DIR"
  git -C "$TARGET_DIR" pull --ff-only
elif [ -e "$TARGET_DIR" ]; then
  err "$TARGET_DIR already exists and is not an arclo-chat checkout. Set ARCLO_DIR to install elsewhere."
else
  info "Cloning arclo-chat into $TARGET_DIR"
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

info "Installing dependencies"
( cd "$TARGET_DIR" && npm install --no-audit --no-fund )

printf '\n\033[1;32m✓ arclo-chat installed.\033[0m\n\n'
echo "  Start it with:"
echo "    cd \"$TARGET_DIR\" && npm start"
echo
echo "  Then open the LAN URL it prints (e.g. http://192.168.x.x:4040)"
echo "  from any device on the same network."
