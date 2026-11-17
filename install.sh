#!/bin/sh
# Pi-personal's installer, for Linux and macOS:
#
#   curl -fsSL https://raw.githubusercontent.com/emiwltz/pi-personal/main/install.sh | sh
#
# or, from a copy of the source: ./install.sh
#
# It puts Pi-personal and its own pinned pi in ~/.local/share/pi-personal (with an official Node.js there too, if
# this machine has none recent enough), and the `pp` command in ~/.local/bin; then it runs `pp setup`, which sets up
# Herdr Core, a model provider and your agent. Nothing else on the machine changes, except your shell's PATH if you
# say yes. Running it again updates Pi-personal and keeps everything else.
#
#   PI_PERSONAL_INSTALL_DIR, PI_PERSONAL_BIN_DIR   where to install (defaults above)
#   PI_PERSONAL_REF=<branch or tag>                the version to download (default: main)
#   PI_PERSONAL_SOURCE=<folder or .tar.gz>         install this copy instead of downloading one
#   PI_PERSONAL_NO_SETUP=1                         do not run `pp setup` at the end
#
# Everything is inside main(), called on the last line: piped through curl, nothing runs before the whole script
# has arrived.
set -eu

main() {
  REPO=emiwltz/pi-personal
  REF=${PI_PERSONAL_REF:-main}
  DEST=${PI_PERSONAL_INSTALL_DIR:-$HOME/.local/share/pi-personal}
  DEST=${DEST%/}
  BIN=${PI_PERSONAL_BIN_DIR:-$HOME/.local/bin}
  BIN=${BIN%/}
  NODE_VERSION=v24.22.3 # an official Node.js LTS release, used only if this machine has no Node.js 22.19 or newer
  NODE_MIN=22.19

  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) fail "Pi-personal runs on Linux and macOS" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) CPU=x64 ;;
    aarch64 | arm64) CPU=arm64 ;;
    *) fail "no build for this processor ($(uname -m))" ;;
  esac
  # Under Rosetta, an Apple silicon Mac says x86_64: use the native build.
  if [ "$OS" = darwin ] && [ "$CPU" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then CPU=arm64; fi
  need curl
  need tar
  if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
  else fail "it needs sha256sum or shasum to check what it downloads"; fi

  # A folder that is neither empty nor an earlier install is never replaced.
  if [ -d "$DEST" ] && [ ! -f "$DEST/.installed" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    fail "$DEST exists and is not a Pi-personal install: choose another folder (PI_PERSONAL_INSTALL_DIR)"
  fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/pi-personal.XXXXXX") || fail "cannot create a temporary folder"
  STAGE="$DEST.new.$$"
  trap 'rm -rf "$TMP" "$STAGE"' EXIT
  trap 'exit 130' INT TERM HUP # so that the cleanup above runs on Ctrl+C too (dash skips it otherwise)
  [ -n "${PI_PERSONAL_UPDATING:-}" ] || say "Pi-personal: your own agent, living in Herdr Core, reachable from anywhere."

  # ---- the source: this copy, a given one, or the latest from GitHub --------------------------------------------
  SRC=
  if [ -n "${PI_PERSONAL_SOURCE:-}" ]; then
    if [ -d "$PI_PERSONAL_SOURCE" ]; then SRC=$(cd "$PI_PERSONAL_SOURCE" && pwd)
    else mkdir -p "$TMP/src" && tar -xzf "$PI_PERSONAL_SOURCE" -C "$TMP/src" || fail "cannot read $PI_PERSONAL_SOURCE"; fi
  elif [ -f "$0" ] && [ "$(basename "$0")" = install.sh ] && [ -f "$(dirname "$0")/core/cli.ts" ]; then
    SRC=$(cd "$(dirname "$0")" && pwd)
  else
    say "Downloading Pi-personal ($REF)..."
    mkdir -p "$TMP/src"
    curl -fsSL --proto '=https' "https://github.com/$REPO/archive/$REF.tar.gz" -o "$TMP/src.tar.gz" || fail "cannot download https://github.com/$REPO ($REF)"
    tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" || fail "the download from https://github.com/$REPO ($REF) is not a source archive"
  fi
  if [ -z "$SRC" ]; then
    found=$(find "$TMP/src" -maxdepth 3 -path '*/core/cli.ts' | head -n 1)
    [ -n "$found" ] || fail "no Pi-personal source in what was downloaded"
    SRC=$(dirname "$(dirname "$found")")
  fi
  [ -f "$SRC/core/cli.ts" ] || fail "no Pi-personal source in $SRC"
  [ "$SRC" = "$DEST" ] && fail "run the installer from a copy of the source, not from the install folder"

  # ---- Node.js: the machine's, if recent enough; else an official build in the install folder -------------------
  NODE=
  if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)" && command -v npm >/dev/null 2>&1; then
    NODE=$(command -v node)
    NPM_PATH=$(dirname "$(command -v npm)")
  else
    NAME=node-$NODE_VERSION-$OS-$CPU
    if [ -x "$DEST/node/$NAME/bin/node" ]; then
      mkdir -p "$STAGE/node" && cp -R "$DEST/node/$NAME" "$STAGE/node/"
    else
      if [ "$OS" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
        fail "this Linux uses musl (Alpine?), and official Node.js builds need glibc: install Node.js $NODE_MIN or newer, then run this again"
      fi
      say "Downloading Node.js $NODE_VERSION (this machine has no Node.js $NODE_MIN or newer)..."
      BASE=https://nodejs.org/dist/$NODE_VERSION
      curl -fsSL --proto '=https' "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "cannot download $BASE/SHASUMS256.txt"
      curl -fsSL --proto '=https' --retry 3 "$BASE/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz" || fail "cannot download $BASE/$NAME.tar.gz"
      WANT=$(awk -v f="$NAME.tar.gz" '$2 == f {print $1}' "$TMP/SHASUMS256.txt")
      GOT=$($SHA "$TMP/$NAME.tar.gz" | awk '{print $1}')
      { [ -n "$WANT" ] && [ "$GOT" = "$WANT" ]; } || fail "the Node.js download does not match its checksum; nothing was installed"
      mkdir -p "$STAGE/node"
      tar -xzf "$TMP/$NAME.tar.gz" -C "$STAGE/node" || fail "cannot unpack Node.js"
    fi
    NODE="$DEST/node/$NAME/bin/node"
    NPM_PATH="$STAGE/node/$NAME/bin"
    "$STAGE/node/$NAME/bin/node" --version >/dev/null || fail "the Node.js downloaded does not run here"
  fi

  # ---- Pi-personal and its pinned pi ------------------------------------------------------------------------------
  say "Installing Pi-personal into $DEST..."
  mkdir -p "$STAGE"
  for f in core channels docs package.json package-lock.json README.md LICENSE install.sh; do
    if [ -e "$SRC/$f" ]; then cp -R "$SRC/$f" "$STAGE/"; fi
  done
  (cd "$STAGE" && PATH="$NPM_PATH:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || fail "npm could not install pi"

  # The pp command, unless another program already has that name in this folder: then only the long name.
  NAMES="pp pi-personal"
  if [ -e "$BIN/pp" ] && ! grep -q "Pi-personal's command" "$BIN/pp" 2>/dev/null; then
    say "note: $BIN/pp is another program; it is left alone, and the command is installed as pi-personal only"
    NAMES="pi-personal"
  fi
  : >"$STAGE/.installed"
  for n in $NAMES; do printf '%s\n' "$BIN/$n" >>"$STAGE/.installed"; done
  rm -rf "$DEST.old"
  if [ -d "$DEST" ]; then mv "$DEST" "$DEST.old"; fi
  mv "$STAGE" "$DEST"
  rm -rf "$DEST.old"

  mkdir -p "$BIN"
  for n in $NAMES; do
cat > "$BIN/$n" <<SHIM
#!/bin/sh
# Pi-personal's command. Its folder comes first on the PATH, so Herdr Core's hc, installed beside it, is found.
PATH="$BIN:\$PATH"; export PATH
[ -x "$NODE" ] && exec "$NODE" "$DEST/core/cli.ts" "\$@"
exec node "$DEST/core/cli.ts" "\$@"
SHIM
    chmod 755 "$BIN/$n"
  done
  CMD=$(printf '%s' "$NAMES" | cut -d' ' -f1)
  say "Installed: $("$BIN/$CMD" --version)"
  [ -n "${PI_PERSONAL_UPDATING:-}" ] && return 0

  # ---- the PATH: the command must be found, and before any other pp (macOS has a Perl tool by that name) -------
  first=$(command -v "$CMD" 2>/dev/null || true)
  if [ "$first" != "$BIN/$CMD" ]; then
    LINE="export PATH=\"$BIN:\$PATH\" # added by Pi-personal's installer"
    case ${SHELL:-} in
      */zsh) RC="$HOME/.zshrc" ;;
      */bash) if [ "$OS" = linux ]; then RC="$HOME/.bashrc"; elif [ -f "$HOME/.bash_profile" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.profile"; fi ;;
      */fish) RC= ;;
      *) RC="$HOME/.profile" ;;
    esac
    if [ -z "$RC" ]; then
      say "To find $CMD in new terminals, run once: fish_add_path -m $BIN"
    elif grep -qF "added by Pi-personal's installer" "$RC" 2>/dev/null; then :
    elif yes_to "Put $BIN first on your PATH, in $RC, so that $CMD is found?"; then
      printf '\n%s\n' "$LINE" >>"$RC"
      say "Added to $RC: new terminals find $CMD."
    else
      say "To use $CMD, put $BIN first on your PATH (export PATH=\"$BIN:\$PATH\" in $RC), or type $BIN/$CMD."
    fi
  fi

  # ---- then the guide -------------------------------------------------------------------------------------------
  if asks; then
    say ""
    if [ "$first" = "$BIN/$CMD" ]; then SHOWN=$CMD; else SHOWN="$BIN/$CMD"; fi
    PI_PERSONAL_COMMAND=$SHOWN "$BIN/$CMD" setup </dev/tty || say "Run it again any time: $SHOWN setup"
  else
    say "Next: $CMD setup"
  fi
  if [ "$first" != "$BIN/$CMD" ]; then
    say ""
    say "In this terminal, $CMD is not found yet: open a new terminal, or run: export PATH=\"$BIN:\$PATH\""
  fi
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'pi-personal install: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "it needs $1, which this machine does not have"; }
# Questions go to the terminal even when this script comes through a pipe (curl ... | sh). In a subshell: a missing
# terminal (a container, CI, ssh without -t) must answer "no", not end the script.
asks() { [ -z "${PI_PERSONAL_NO_SETUP:-}" ] && (: </dev/tty) 2>/dev/null; }
yes_to() {
  asks || return 1
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r a </dev/tty || return 1
  case $a in "" | y | Y | yes | o | oui) return 0 ;; *) return 1 ;; esac
}
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);const [x,y]=process.argv[1].split(".").map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)' "$NODE_MIN" 2>/dev/null; }

main "$@"
