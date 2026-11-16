#!/bin/sh
set -eu

fail() {
    printf 'encoder: %s\n' "$*" >&2
    exit 1
}

if [ "$#" -gt 1 ]; then
    fail "usage: install.sh [amd64|arm64]"
fi
if [ "$#" -eq 1 ]; then
    case "$1" in
        amd64|arm64) ;;
        *) fail "unsupported srtla_send architecture '$1' (expected amd64 or arm64)" ;;
    esac
fi

executable_on_path() {
    resolved=$(command -v "$1" 2>/dev/null) || return 1
    [ -f "$resolved" ] && [ -x "$resolved" ]
}

if [ "${SRTLA_SEND_BIN+x}" = x ]; then
    if [ -n "$SRTLA_SEND_BIN" ] && executable_on_path "$SRTLA_SEND_BIN"; then
        printf 'encoder: using SRTLA_SEND_BIN=%s\n' "$resolved"
        exit 0
    fi
    case "$SRTLA_SEND_BIN" in
        srtla_send|/usr/bin/srtla_send) ;;
        *) fail "SRTLA_SEND_BIN '$SRTLA_SEND_BIN' is not executable; correct or unset it" ;;
    esac
elif executable_on_path srtla_send; then
    printf 'encoder: srtla_send already on PATH (%s)\n' "$resolved"
    exit 0
fi

if [ "${CTRLIRL_INSTALL_ROOT:-${CTRLIRL_ROOT_OVERRIDE:-/}}" != / ]; then
    fail "cannot install the system package with a non-default install root; use --dry-run or a fake provider"
fi
if ! native_arch=$(dpkg --print-architecture); then
    fail "cannot determine the Debian architecture"
fi
arch=${1:-$native_arch}
case "$arch" in
    amd64|arm64) ;;
    *) fail "unsupported Debian architecture '$arch' (expected amd64 or arm64)" ;;
esac
if [ "$arch" != "$native_arch" ]; then
    fail "requested architecture '$arch' does not match the host architecture '$native_arch'"
fi
if ! command -v curl >/dev/null 2>&1; then
    fail "curl is required to download srtla_send; install dependencies with --install-deps"
fi

if ! tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/ctrlirl-srtla.XXXXXXXX"); then
    fail "cannot create a temporary directory for srtla_send"
fi
deb_path=
cleanup() {
    if [ -n "$deb_path" ]; then
        rm -f -- "$deb_path"
    fi
    rm -f -- "$tmpdir/release.json" "$tmpdir/sha256sums.txt" "$tmpdir/selected.sha256"
    rmdir -- "$tmpdir"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

download() {
    curl -fsSL --retry 2 --connect-timeout 15 --max-time 180 \
        --proto '=https' --proto-redir '=https' -o "$1" "$2"
}

api=https://api.github.com/repos/irlserver/srtla_send/releases/latest
if ! download "$tmpdir/release.json" "$api"; then
    fail "could not fetch the latest srtla_send release from GitHub"
fi
url=$(grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://github[.]com/irlserver/srtla_send/releases/download/[A-Za-z0-9._+-]+/srtla_[A-Za-z0-9.+_~-]+_'"$arch"'[.]deb"' "$tmpdir/release.json" | cut -d '"' -f 4)
case "$url" in
    "") fail "the latest srtla_send release has no $arch Debian package" ;;
    *'
'*) fail "the latest srtla_send release has multiple $arch Debian packages" ;;
esac
deb_name=${url##*/}
deb_path="$tmpdir/$deb_name"
if ! download "$deb_path" "$url"; then
    fail "could not download $deb_name"
fi
if ! download "$tmpdir/sha256sums.txt" "${url%/*}/sha256sums.txt"; then
    fail "could not download the srtla_send release checksums"
fi
if ! awk -v file="$deb_name" '
    $2 == file || $2 == "*" file { print; count++ }
    END { if (count != 1) exit 1 }
' "$tmpdir/sha256sums.txt" > "$tmpdir/selected.sha256"; then
    fail "the release checksum for $deb_name is missing or ambiguous"
fi
if ! (cd "$tmpdir" && sha256sum --check selected.sha256); then
    fail "checksum verification failed for $deb_name"
fi
if ! package=$(dpkg-deb -f "$deb_path" Package); then
    fail "could not inspect $deb_name"
fi
if ! package_arch=$(dpkg-deb -f "$deb_path" Architecture); then
    fail "could not inspect the architecture of $deb_name"
fi
if [ "$package" != srtla ] || [ "$package_arch" != "$arch" ]; then
    fail "unexpected Debian package in $deb_name (package: $package, architecture: $package_arch)"
fi
if ! chmod 0755 "$tmpdir" || ! chmod 0644 "$deb_path"; then
    fail "could not make $deb_name accessible to apt"
fi
if ! apt-get install -y --reinstall "$deb_path"; then
    fail "apt-get failed to install $deb_name"
fi
if ! executable_on_path "${SRTLA_SEND_BIN:-srtla_send}"; then
    fail "srtla_send is not executable on PATH or at SRTLA_SEND_BIN after installing $deb_name"
fi
printf 'encoder: installed srtla_send (%s) at %s\n' "$arch" "$resolved"
