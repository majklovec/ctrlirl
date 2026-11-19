#!/usr/bin/env bash
#
# Builds a .deb package for the ceracoder encoder.
#
# The binary is compiled in Docker (Dockerfile.ceracoder): one builder image
# per architecture. ceracoder links GStreamer (apt packages) and the CERALIVE
# SRT fork, which is not in apt — the fork is built in the image next to the
# binary and bundled into the package (with a libsrt.so.1 bridge symlink, as
# in Dockerfile.device), so the deb is self-contained.
#
#   amd64 builds natively.
#   arm64 builds with QEMU binfmt emulation on an x86-64 host; the SRT +
#   ceracoder build takes a while (~15 min single core). Set REBUILD=1 to
#   force rebuilding the builder image.
#
# Usage:
#   ./scripts/package_ceracoder.sh            # amd64 (default)
#   ./scripts/package_ceracoder.sh arm64      # arm64
#
# Environment:
#   CERACODER_BIN   skip Docker, use this prebuilt binary instead
#   SRT_LIB         with CERACODER_BIN, the CERALIVE libsrt to bundle
#                   (default: real file behind /usr/local/lib/libsrt.so.1)
#   CERACODER_VERSION  package version (default: version from package.json)
#   REBUILD=1       force rebuilding the builder image
#
# Output: dist/ceracoder_<version>_<arch>.deb
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"
IMAGE_TAG="ceracoder-builder"

fail() {
	echo "error: $*" >&2
	exit 1
}

ARCH="${1:-amd64}"
case "${ARCH}" in
amd64)
	MULTIARCH="x86_64-linux-gnu"
	MACHINE_PAT="*X86-64*"
	PLATFORM="linux/amd64"
	QEMU_ARCH=""
	;;
arm64)
	MULTIARCH="aarch64-linux-gnu"
	MACHINE_PAT="*AArch64*"
	PLATFORM="linux/arm64"
	QEMU_ARCH="arm64"
	;;
*)
	fail "unsupported arch '${ARCH}' (expected amd64 or arm64)"
	;;
esac

# --- Package version --------------------------------------------------------
VERSION="${CERACODER_VERSION:-$(grep -m1 '"version"' "${REPO_ROOT}/package.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')}"
[ -n "${VERSION}" ] || fail "could not determine package version (set CERACODER_VERSION)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
BIN="${TMP}/ceracoder"
SRT_LIB=""

# --- Obtain binary + SRT fork ------------------------------------------------
if [ -n "${CERACODER_BIN:-}" ]; then
	# Prebuilt binary (e.g. built natively on the device)
	[ -f "${CERACODER_BIN}" ] || fail "CERACODER_BIN not found: ${CERACODER_BIN}"
	cp "${CERACODER_BIN}" "${BIN}"
	SRT_LIB="${SRT_LIB:-$(readlink -f /usr/local/lib/libsrt.so.1 2>/dev/null || true)}"
	[ -n "${SRT_LIB}" ] && [ -f "${SRT_LIB}" ] || fail "CERALIVE libsrt not found — set SRT_LIB (path to libsrt.so.1.* of the CERALIVE fork)"
	cp "${SRT_LIB}" "${TMP}/$(basename "${SRT_LIB}")"
	SRT_LIB="${TMP}/$(basename "${SRT_LIB}")"
elif ! command -v docker >/dev/null; then
	fail "docker not found — install it, or set CERACODER_BIN to a prebuilt binary"
else
	IMAGE="${IMAGE_TAG}:${ARCH}"

	# QEMU binfmt for cross-architecture builds (needed once, persists in the
	# host kernel). Skipped when building the native architecture or when it
	# is already registered.
	HOST_PLATFORM="linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
	if [ -n "${QEMU_ARCH}" ] && [ "${PLATFORM}" != "${HOST_PLATFORM}" ]; then
		if [ ! -e "/proc/sys/fs/binfmt_misc/qemu-${QEMU_ARCH}" ]; then
			echo "==> Ensuring QEMU binfmt for ${QEMU_ARCH} (one-time)..."
			docker run --privileged --rm tonistiigi/binfmt --install "${QEMU_ARCH}" >/dev/null ||
				fail "could not install QEMU binfmt for ${QEMU_ARCH} (docker must allow privileged containers)"
		fi
	fi

	# Build the builder image if missing (one per architecture).
	if [ "${REBUILD:-0}" = "1" ] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
		echo "==> Building builder image ${IMAGE} (${PLATFORM})..."
		[ -n "${QEMU_ARCH}" ] && echo "    (cross-compiled via QEMU — this can take a while)"
		docker build --platform "${PLATFORM}" -t "${IMAGE}" -f "${REPO_ROOT}/Dockerfile.ceracoder" "${REPO_ROOT}"
	fi

	# Extract the binary and the SRT fork from the image. The SRT fork keeps
	# its real (versioned) file name; the libsrt.so.1 bridge is a symlink.
	echo "==> Extracting binary + SRT fork from ${IMAGE}..."
	CID="$(docker create "${IMAGE}")"
	docker cp "${CID}:/build/ceracoder/ceracoder" "${BIN}" >/dev/null
	SRT_NAME="$(docker run --rm --entrypoint sh "${IMAGE}" -c 'basename "$(readlink -f /usr/local/lib/libsrt.so.1)"')"
	[ -n "${SRT_NAME}" ] || {
		docker rm "${CID}" >/dev/null
		fail "libsrt.so.1 not found in ${IMAGE}"
	}
	SRT_LIB="${TMP}/${SRT_NAME}"
	docker cp "${CID}:/usr/local/lib/${SRT_NAME}" "${SRT_LIB}" >/dev/null
	docker rm "${CID}" >/dev/null
fi

chmod 0755 "${BIN}"

# --- Verify the extracted/selected binary matches the target arch -----------
MACHINE="$(readelf -h "${BIN}" | awk '/Machine:/ {print $NF}')"
[[ "${MACHINE}" == ${MACHINE_PAT} ]] || fail "${BIN} is ${MACHINE}, not ${ARCH}"
echo "Binary:      ${BIN} (${MACHINE})"
SRT_MACHINE="$(readelf -h "${SRT_LIB}" | awk '/Machine:/ {print $NF}')"
[[ "${SRT_MACHINE}" == ${MACHINE_PAT} ]] || fail "${SRT_LIB} is ${SRT_MACHINE}, not ${ARCH}"
echo "SRT fork:    $(basename "${SRT_LIB}") (${SRT_MACHINE})"

# soname the binary actually NEEDs — the package ships a symlink of that name
# pointing at the real (versioned) fork file, like Dockerfile.device's bridge.
SRT_SONAME="$(readelf -d "${BIN}" | awk '/NEEDED/ && /libsrt/ {gsub(/.*\[|\]/, ""); print; exit}')"
[ -n "${SRT_SONAME}" ] || fail "could not determine the libsrt soname needed by ${BIN}"

# --- Assemble the package tree ----------------------------------------------
BUILD_DIR="$(mktemp -d)"

mkdir -p \
	"${BUILD_DIR}/usr/bin" \
	"${BUILD_DIR}/usr/lib/${MULTIARCH}" \
	"${BUILD_DIR}/usr/share/ceracoder" \
	"${BUILD_DIR}/etc" \
	"${BUILD_DIR}/DEBIAN"

install -m 0755 "${BIN}" "${BUILD_DIR}/usr/bin/ceracoder"
# The CERALIVE fork installs as libsrt.so.1.<ver> while ceracoder NEEDs the
# libsrt soname — bridge like Dockerfile.device does.
install -m 0644 "${SRT_LIB}" "${BUILD_DIR}/usr/lib/${MULTIARCH}/$(basename "${SRT_LIB}")"
[ "$(basename "${SRT_LIB}")" != "${SRT_SONAME}" ] &&
	ln -s "$(basename "${SRT_LIB}")" "${BUILD_DIR}/usr/lib/${MULTIARCH}/${SRT_SONAME}"
install -m 0644 "${REPO_ROOT}/ceracoder.conf" "${BUILD_DIR}/etc/ceracoder.conf"
cp -r "${REPO_ROOT}/pipeline/." "${BUILD_DIR}/usr/share/ceracoder/pipeline/"

cat >"${BUILD_DIR}/DEBIAN/control" <<EOF
Package: ceracoder
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Michal Vondráček <michal.vondracek@optimal4.cz>
Section: video
Priority: optional
Depends: libgstreamer1.0-0, libgstapp1.0-0 | libgstreamer-plugins-base1.0-0
Description: Adaptive SRT encoder with bitrate control
 Encoder process for CtrlIRL streaming devices. Drives the GStreamer
 encoding pipeline and adapts the source bitrate to the uplink using
 adaptive/AIMD balancer algorithms. Ships the CERALIVE SRT fork
 libsrt.so.1, the default /etc/ceracoder.conf and the platform
 pipeline definitions in /usr/share/ceracoder/pipeline/.
EOF

echo "/etc/ceracoder.conf" >"${BUILD_DIR}/DEBIAN/conffiles"

# The bundled libsrt.so.1 has no RUNPATH in the binary, so the dynamic
# linker cache must be refreshed after install (and again after removal so
# the stale entry goes away).
cat >"${BUILD_DIR}/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
ldconfig
EOF
cat >"${BUILD_DIR}/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
ldconfig
EOF
chmod 0755 "${BUILD_DIR}/DEBIAN/postinst" "${BUILD_DIR}/DEBIAN/prerm"

# --- Build the .deb -----------------------------------------------------------
mkdir -p "${DIST_DIR}"
OUT="${DIST_DIR}/ceracoder_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "${BUILD_DIR}" "${OUT}" >/dev/null
rm -rf "${BUILD_DIR}"
echo
echo "Built: ${OUT} ($(du -h "${OUT}" | cut -f1))"
sha256sum "${OUT}"
