#!/bin/sh
# Install Pi-personal from this folder: its code and its own pinned copy of pi go into one directory,
# and a `pi-personal` command goes next to your other commands. Nothing else on the machine is changed.
#
#   ./install.sh                      installs into ~/.local/share/pi-personal, command in ~/.local/bin
#   PI_PERSONAL_INSTALL_DIR=... PI_PERSONAL_BIN_DIR=... ./install.sh
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=${PI_PERSONAL_INSTALL_DIR:-$HOME/.local/share/pi-personal}
BIN=${PI_PERSONAL_BIN_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 22.19 or newer is needed: https://nodejs.org"
NODE=$(command -v node)
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || fail "Node.js $(node --version) is too old: 22.19 or newer is needed"
command -v npm >/dev/null 2>&1 || fail "npm is needed (it comes with Node.js)"
command -v hc >/dev/null 2>&1 || say "note: Herdr Core's hc command was not found; install Herdr Core before starting an agent: https://herdr.dev"

[ "$SRC" = "$DEST" ] && fail "run the installer from a copy of the source, not from the install directory"
say "Installing Pi-personal into $DEST"
STAGE="$DEST.new.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
for f in core channels docs package.json package-lock.json README.md install.sh; do
  [ -e "$SRC/$f" ] && cp -R "$SRC/$f" "$STAGE/"
done
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || { rm -rf "$STAGE"; fail "npm could not install pi"; }
printf '%s\n' "$BIN/pi-personal" > "$STAGE/.installed"
rm -rf "$DEST.old"
[ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$STAGE" "$DEST"
rm -rf "$DEST.old"

mkdir -p "$BIN"
cat > "$BIN/pi-personal" <<SHIM
#!/bin/sh
# The Node.js found at install time; if it moved (an upgrade), the one on the PATH.
[ -x "$NODE" ] && exec "$NODE" "$DEST/core/cli.ts" "\$@"
exec node "$DEST/core/cli.ts" "\$@"
SHIM
chmod 755 "$BIN/pi-personal"

say "Installed. Next:"
case ":$PATH:" in *":$BIN:"*) ;; *) say "  add $BIN to your PATH" ;; esac
say "  pi-personal doctor"
say "  pi-personal init main --model <provider/id>     (pi-personal models lists them)"
say "Updating later: run this installer again from the new source, then: pi-personal restart <agent>"
