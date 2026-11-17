#!/usr/bin/env bash
# Build the `udpip` userspace UDP↔TUN IP-pump as a static binary.
#
# Static (CGO_ENABLED=0) so the single file runs on both hosts' glibc
# (2.31 relay / 2.35 encoder) with no shared-lib dependencies. Pure-Go stdlib
# + golang.org/x/sys/unix only.
#
# Usage:
#   ./build.sh            # linux/arm64 → dist/udpip
#   ./build.sh amd64      # linux/amd64 → dist/udpip-amd64 (dev box)
#   GOARCH=arm64 ...       (override via env)
#
# The binary is NOT committed to the repo (like `client-arm`); it is deployed
# by scp to /usr/local/bin/udpip on each host.
set -euo pipefail

GOARCH="${1:-arm64}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/src"
OUTDIR="$HERE/dist"

mkdir -p "$OUTDIR"
outname="udpip"
[[ "$GOARCH" != "arm64" ]] && outname="udpip-$GOARCH"
out="$OUTDIR/$outname"

# Resolve the single x/sys dependency (no-op if go.sum is already present).
( cd "$HERE" && go mod download golang.org/x/sys >/dev/null 2>&1 || go mod tidy )

echo "→ building udpip (linux/$GOARCH) → $out"
# Run the build from inside the module dir ($HERE has go.mod); the source lives in src/.
( cd "$HERE" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
	go build -trimpath -ldflags="-s -w" -o "$out" ./src )

ls -lh "$out"
echo "done."
