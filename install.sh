#!/bin/sh
# Mnemyx standalone installer — Linux/macOS, no Bun needed.
#
# Downloads the prebuilt CLI + MCP server binaries from GitHub Releases,
# verifies SHA-256 checksums, and installs them.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/NoahMenezes/Mnemyx/main/install.sh | sh
#   MNEMYX_VERSION=0.1.0 sh install.sh            # pin a version (default: latest)
#   MNEMYX_INSTALL_DIR=/usr/local/bin sh install.sh  # system-wide (needs sudo)
set -eu

REPO="NoahMenezes/Mnemyx"
VERSION="${MNEMYX_VERSION:-latest}"
INSTALL_DIR="${MNEMYX_INSTALL_DIR:-$HOME/.local/bin}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "mnemyx installer: need '$1' (install it and re-run)" >&2
    exit 1
  }
}
need curl
need uname
need mktemp

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "mnemyx installer: unsupported OS '$OS' (Linux/macOS only)" >&2
    exit 1
    ;;
esac
case "$ARCH" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "mnemyx installer: unsupported arch '$ARCH' (x64/arm64 only)" >&2
    exit 1
    ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  SHASUM="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHASUM="shasum -a 256"
else
  echo "mnemyx installer: need 'sha256sum' or 'shasum' (install it and re-run)" >&2
  exit 1
fi

# Resolve 'latest' to a tag like v0.1.0 via the releases/latest redirect.
if [ "$VERSION" = "latest" ]; then
  TAG="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/##')"
  [ -n "$TAG" ] || {
    echo "mnemyx installer: could not resolve latest release" >&2
    exit 1
  }
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
fi

BASE="https://github.com/$REPO/releases/download/$TAG"
CLI="mnemyx-$os-$arch"
SRV="mnemyx-server-$os-$arch"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "mnemyx installer: $TAG for $os/$arch -> $INSTALL_DIR"
curl -fsSL --retry 3 -o "$TMP/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt"
curl -fsSL --retry 3 -o "$TMP/$CLI" "$BASE/$CLI"
curl -fsSL --retry 3 -o "$TMP/$SRV" "$BASE/$SRV"

# Verify checksums (subset of the release's SHA256SUMS.txt).
grep -E " ($CLI|$SRV)\$" "$TMP/SHA256SUMS.txt" >"$TMP/check.txt"
(cd "$TMP" && $SHASUM -c check.txt)

mkdir -p "$INSTALL_DIR"
cp "$TMP/$CLI" "$INSTALL_DIR/mnemyx"
cp "$TMP/$SRV" "$INSTALL_DIR/mnemyx-server"
chmod 755 "$INSTALL_DIR/mnemyx" "$INSTALL_DIR/mnemyx-server"

"$INSTALL_DIR/mnemyx" --version

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "NOTE: $INSTALL_DIR is not on your PATH — add it, then run 'mnemyx init'" >&2 ;;
esac

echo "installed. next: mnemyx init"
echo "for AI clients, point them at: $INSTALL_DIR/mnemyx-server"
