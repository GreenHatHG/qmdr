#!/bin/sh
# QMDR installer: qmd (full CLI) + qmdr (read-only agent front end).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/GreenHatHG/qmdr/main/scripts/install.sh | sh
#   sh install.sh [--binary] [--fix-bun]
#
# Flags:
#   --binary   install the prebuilt qmd binary instead of Bun source mode
#   --fix-bun  downgrade/upgrade Bun to a known-good version (default bun-v1.3.6)
#
# Env:
#   QMDR_BUN_VERSION   Bun ref to install when Bun is missing (default bun-v1.3.6)
#   BUN_INSTALL_MIRROR China mirror for the Bun installer, e.g.
#                      https://npmmirror.com/mirrors/bun
set -eu

REPO="github:GreenHatHG/qmdr"
RAW_BASE="https://raw.githubusercontent.com/GreenHatHG/qmdr/main"
BUN_REF="${QMDR_BUN_VERSION:-bun-v1.3.6}"
# Bun 1.3.7+ has a sqlite-vec segfault (oven-sh/bun#26572). Bad if > 1.3.6.
BUN_MAX_MINOR=3
BUN_MAX_PATCH=6

FIX_BUN=0
BINARY=0
for arg in "$@"; do
  case $arg in
    --binary) BINARY=1 ;;
    --fix-bun) FIX_BUN=1 ;;
    *) echo "install.sh: unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { echo "install.sh: $*"; }
die() { echo "install.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- install target dir: prefer ~/.local/bin, fall back to /usr/local/bin ---
if [ ! -d "$HOME/.local/bin" ]; then
  mkdir -p "$HOME/.local/bin" 2>/dev/null || true
fi
if [ -d "$HOME/.local/bin" ] && [ -w "$HOME/.local/bin" ]; then
  PREFIX="$HOME/.local/bin"
elif [ -w /usr/local/bin ]; then
  PREFIX="/usr/local/bin"
else
  die "no writable install dir ($HOME/.local/bin or /usr/local/bin)"
fi

bun_ok() {
  # true if bun is 1.3.0 .. 1.3.6
  v=$(bun --version 2>/dev/null) || return 1
  major=$(echo "$v" | cut -d. -f1)
  minor=$(echo "$v" | cut -d. -f2)
  patch=$(echo "$v" | cut -d. -f3)
  [ "$major" -eq 1 ] || return 1
  [ "$minor" -eq "$BUN_MAX_MINOR" ] || [ "$minor" -lt "$BUN_MAX_MINOR" ] || return 1
  if [ "$minor" -eq "$BUN_MAX_MINOR" ] && [ "$patch" -gt "$BUN_MAX_PATCH" ]; then
    return 1
  fi
  return 0
}

install_bun() {
  say "installing Bun $BUN_REF ..."
  if [ -n "${BUN_INSTALL_MIRROR:-}" ]; then
    curl -fsSL https://bun.sh/install | BUN_INSTALL_MIRROR="$BUN_INSTALL_MIRROR" bash -s "$BUN_REF"
  else
    curl -fsSL https://bun.sh/install | bash -s "$BUN_REF"
  fi
  export PATH="$HOME/.bun/bin:$PATH"
}

# --- PATH: make ~/.bun/bin and the prefix visible now and in future shells ---
add_rc_line() {
  rc=$1
  [ -f "$rc" ] || touch "$rc"
  grep -qs "\.bun/bin" "$rc" && return 0
  printf '\n# bun global bins (qmd/qmdr)\nexport PATH="$HOME/.bun/bin:$PATH"\n' >> "$rc"
  say "added ~/.bun/bin to PATH in $rc"
}

# --- wrapper: self-contained, works in shells without ~/.bun/bin on PATH ---
# Written for both bins; keeps working after `bun install -g` upgrades.
write_wrapper() {
  name=$1
  cat > "$PREFIX/$name" <<EOF
#!/bin/sh
PATH="\$HOME/.bun/bin:\$PATH"
export PATH
: "\${QMD_LOCAL_BIN:=\$HOME/.bun/bin/qmd}"
export QMD_LOCAL_BIN
exec "\$HOME/.bun/bin/$name" "\$@"
EOF
  chmod +x "$PREFIX/$name"
}

# The qmdr shim is not a bun bin until the repo's package.json bin map lands on
# GitHub. Link it by hand so `bun install -g` alone is enough.
link_qmdr_shim() {
  pkg="$HOME/.bun/install/global/node_modules/qmdr"
  [ -x "$pkg/remote/bin/qmdr" ] || return 0
  ln -sf "../install/global/node_modules/qmdr/remote/bin/qmdr" "$HOME/.bun/bin/qmdr"
}

install_from_source() {
  if have bun; then
    if bun_ok; then
      say "using existing Bun $(bun --version)"
    elif [ "$FIX_BUN" -eq 1 ]; then
      install_bun
    else
      say "WARNING: Bun $(bun --version) found. 1.3.7+ has a sqlite-vec segfault"
      say "         (github.com/oven-sh/bun/issues/26572). Install anyway;"
      say "         re-run with --fix-bun to pin Bun $BUN_REF."
    fi
  else
    install_bun
  fi

  say "installing qmdr from $REPO ..."
  bun install -g "$REPO"

  fix_shim_files

  write_wrapper qmd
  write_wrapper qmdr
  link_qmdr_shim
  say "installed: $PREFIX/qmd, $PREFIX/qmdr"
}

fix_shim_files() {
  # Bun's GitHub install drops the remote/ dir from the package (bun ignores
  # it during packing even though npm pack keeps it). The qmdr shim lives
  # there, so fetch the 4 files straight from the repo into the install dir.
  pkg="$HOME/.bun/install/global/node_modules/qmdr"
  [ -f "$pkg/remote/bin/qmdr" ] && return 0
  [ -d "$pkg" ] || return 0
  say "restoring qmdr shim files (bun pack omits remote/) ..."
  mkdir -p "$pkg/remote/bin" || return 0
  for f in qmdr qmd-ro.ts qmd-help.txt qmd-help-full.txt; do
    curl -fsSL "$RAW_BASE/remote/bin/$f" -o "$pkg/remote/bin/$f" \
      || die "failed to fetch remote/bin/$f"
    [ "$f" = "qmd-ro.ts" -o "$f" = "qmdr" ] && chmod +x "$pkg/remote/bin/$f"
  done
}

install_binary() {
  os=$(uname -s | tr A-Z a-z)
  case $os in
    darwin|linux) ;;
    *) die "--binary supports macOS/Linux only; use the PowerShell snippet in AI-SETUP.md for Windows" ;;
  esac
  arch=$(uname -m)
  [ "$arch" = "x86_64" ] && arch="x64"
  say "downloading qmd-$os-$arch ..."
  url="https://github.com/GreenHatHG/qmdr/releases/latest/download/qmd-$os-$arch"
  curl -fL "$url" -o "$PREFIX/qmd" || die "download failed: $url"
  chmod +x "$PREFIX/qmd"
  say "installed: $PREFIX/qmd"
  say "note: binary mode ships qmd only; the qmdr read-only front end needs source mode"
}

verify() {
  if ! have qmd; then
    export PATH="$PREFIX:$HOME/.bun/bin:$PATH"
  fi
  add_rc_line "$HOME/.bashrc"
  add_rc_line "$HOME/.profile"
  # macOS default shell
  [ "$(uname -s)" = "Darwin" ] && add_rc_line "$HOME/.zshrc"

  say "running qmd doctor ..."
  if qmd doctor 2>/dev/null; then
    :
  else
    say "qmd doctor could not run in this shell. Open a new shell and try again."
  fi
  say "done. If an AI agent shell still can't find qmd/qmdr, run: hash -r"
}

if [ "$BINARY" -eq 1 ]; then
  install_binary
else
  install_from_source
fi
verify
