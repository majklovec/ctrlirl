#!/bin/bash
# userpatches/customize-image.sh
#
# Shared customization for the SD-card image and the eMMC auto-install image.
# The eMMC variant is selected by BUILD_VARIANT="emmc" in
# userpatches/config-orangepi5-plus-emmc.conf.
#
# FIX HISTORY:
#   1. gstreamer-rockchip needed a newer MPP -> switched to rockchip-linux/mpp develop.
#   2. libv4l-rkmpp needs libv4l2.pc -> added libv4l-dev.
#   3. libv4l-rkmpp fails on .mmap (API mismatch) -> patch out the .mmap assignment.
#   4. Bun installer requires unzip -> added unzip (+ curl) to the package list.
#   5. ctrlirl-coder ships in its own apt repo -> add keyring + sources entry (section 1).

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ============================================================
# Configuration
# ============================================================
HOSTNAME_VAL="ctrlirl"
BUILD_DIR="${HOME}/rk-gst-build"

# ============================================================
# 1. APT setup + single consolidated package install
# ============================================================
# Add the ctrlirl-coder apt repository (keyring + source list).
mkdir -p /etc/apt/keyrings
curl -fsSL https://majklovec.github.io/ctrlirl-coder/deb/ctrlirl.asc \
	-o /etc/apt/keyrings/ctrlirl.asc
echo "deb [signed-by=/etc/apt/keyrings/ctrlirl.asc] https://majklovec.github.io/ctrlirl-coder/deb ctrlirl main" \
	>/etc/apt/sources.list.d/ctrlirl-coder.list

apt-get update
apt-get install -y --no-install-recommends \
	software-properties-common \
	nano build-essential git tcl libssl-dev nodejs npm usb-modeswitch \
	ca-certificates pkg-config cmake meson ninja-build \
	curl unzip \
	libv4l-0 libv4l-dev \
	libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
	gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
	gstreamer1.0-plugins-ugly gstreamer1.0-libav \
	gstreamer1.0-gl gstreamer1.0-tools \
	libdrm-dev libx11-dev libwayland-dev libegl-dev libgles-dev \
	avahi-daemon avahi-utils libnss-mdns \
	ctrlirl-coder

# ============================================================
# 2. Sanity checks (warn-only — never block the automated build)
# ============================================================
if git config --global --get-regexp '^url\..*\.insteadOf' >/dev/null 2>&1; then
	echo "WARNING: global git URL rewrite rules detected (may break github.com):"
	git config --global --get-regexp '^url\..*\.insteadOf'
fi

if [[ ! -e /dev/mpp_service || ! -e /dev/rga ]]; then
	echo "WARNING: /dev/mpp_service or /dev/rga not found (kernel: $(uname -r))."
	echo "         HW encode/RGA needs a Rockchip 6.1 vendor kernel; continuing anyway."
fi

# ============================================================
# 3. Build the Rockchip GStreamer stack from source
# ============================================================
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

build_mpp() {
	echo "=== Building Rockchip MPP (rockchip-linux/mpp, develop branch) ==="
	rm -rf mpp-rockchip
	git clone --depth=1 --single-branch --branch develop \
		https://github.com/rockchip-linux/mpp mpp-rockchip
	cmake -B mpp-rockchip/build -S mpp-rockchip \
		-DCMAKE_INSTALL_PREFIX=/usr \
		-DCMAKE_INSTALL_LIBDIR=lib/aarch64-linux-gnu \
		-DCMAKE_BUILD_TYPE=Release \
		-DBUILD_SHARED_LIBS=ON \
		-DBUILD_TEST=OFF \
		-DCMAKE_POLICY_VERSION_MINIMUM=3.5
	cmake --build mpp-rockchip/build -j"$(nproc)"
	cmake --install mpp-rockchip/build

	local mpp_inc="/usr/include/rockchip"
	if ! grep -rq 'mpp_frame_get_fmt_layout' "${mpp_inc}/"; then
		echo "ERROR: mpp_frame_get_fmt_layout() not found under ${mpp_inc}/." >&2
		exit 1
	fi
	if ! grep -rq 'MPP_FMT_AFBC16X16' "${mpp_inc}/"; then
		echo "ERROR: MPP_FMT_AFBC16X16 not found under ${mpp_inc}/." >&2
		exit 1
	fi
	echo "MPP headers verified: mpp_frame_get_fmt_layout + MPP_FMT_AFBC16X16 present."
}

build_librga() {
	echo "=== Building librga ==="
	rm -rf librga-rockchip
	git clone --depth=1 https://github.com/tsukumijima/librga-rockchip librga-rockchip
	meson setup librga-rockchip/build librga-rockchip \
		--prefix=/usr --libdir=lib/aarch64-linux-gnu --buildtype=release
	ninja -C librga-rockchip/build
	ninja -C librga-rockchip/build install
}

build_gst_rockchip() {
	echo "=== Building gstreamer-rockchip ==="
	rm -rf gstreamer-rockchip
	git clone --depth=1 --single-branch --branch gstreamer-rockchip \
		https://github.com/JeffyCN/mirrors gstreamer-rockchip
	meson setup gstreamer-rockchip/build gstreamer-rockchip \
		--prefix=/usr --libdir=lib/aarch64-linux-gnu --buildtype=release \
		-Drockchipmpp=enabled -Drga=enabled
	ninja -C gstreamer-rockchip/build
	ninja -C gstreamer-rockchip/build install
}

build_libv4l_rkmpp() {
	echo "=== Building libv4l-rkmpp ==="
	rm -rf libv4l-rkmpp
	git clone --depth=1 https://github.com/JeffyCN/libv4l-rkmpp libv4l-rkmpp

	# --- fix: remove .mmap assignment that is not present in the
	#     standard libv4l_dev_ops struct shipped by libv4l-dev ---
	sed -i '/\.mmap = &plugin_mmap,/d' libv4l-rkmpp/src/libv4l-rkmpp.c

	meson setup libv4l-rkmpp/build libv4l-rkmpp \
		--prefix=/usr --libdir=lib/aarch64-linux-gnu --buildtype=release
	ninja -C libv4l-rkmpp/build
	ninja -C libv4l-rkmpp/build install
}

build_mpp
build_librga
build_gst_rockchip
build_libv4l_rkmpp

ldconfig
rm -rf "${HOME}/.cache/gstreamer-1.0"

# ============================================================
# 4. Hostname
# ============================================================
echo "Setting hostname to ${HOSTNAME_VAL}..."
echo "${HOSTNAME_VAL}" >/etc/hostname
if grep -q "^127.0.1.1" /etc/hosts; then
	sed -i "s/^127.0.1.1.*/127.0.1.1\t${HOSTNAME_VAL}/" /etc/hosts
else
	printf '127.0.1.1\t%s\n' "${HOSTNAME_VAL}" >>/etc/hosts
fi
hostname "${HOSTNAME_VAL}" 2>/dev/null || true

# ============================================================
# 5. Avahi / mDNS
# ============================================================
systemctl enable avahi-daemon 2>/dev/null || true
sed -i 's/^hosts:.*/hosts:          files mdns4_minimal [NOTFOUND=return] dns myhostname/' \
	/etc/nsswitch.conf

# ============================================================
# 6. DNS via systemd-resolved
# ============================================================
mkdir -p /etc/systemd/resolved.conf.d
cat >/etc/systemd/resolved.conf.d/dns.conf <<'EOF'
[Resolve]
DNS=8.8.8.8 8.8.4.4
FallbackDNS=1.1.1.1
EOF
systemctl enable systemd-resolved 2>/dev/null || true

# ============================================================
# 7. Bun
# ============================================================
echo "Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="${HOME}/.bun"
export PATH="${BUN_INSTALL}/bin:${PATH}"

# ============================================================
# 8. ctrlirl
# ============================================================
echo "Installing ctrlirl..."
git clone https://github.com/majklovec/ctrlirl.git /opt/ctrlirl
cd /opt/ctrlirl
[[ -f package.json ]] && bun install

# ============================================================
# 9. Overlay (systemd, udev, etc.)
# ============================================================
if [ -d /tmp/overlay ]; then
	echo "Applying overlay files..."
	cp -r --no-preserve=ownership /tmp/overlay/. /

	# Fix permissions on custom udev rules & hwdb files
	if [ -d /tmp/overlay/etc/udev/rules.d ]; then
		find /etc/udev/rules.d -maxdepth 1 -type f -name '*.rules' -exec chmod 0644 {} +
	fi

	# Enable any custom systemd services shipped in overlay/etc/systemd/system/
	# (excluding the eMMC-only installer service handled in section 10)
	if [ -d /tmp/overlay/etc/systemd/system ]; then
		for unit in /tmp/overlay/etc/systemd/system/*.service; do
			[ -e "$unit" ] || continue
			unit_name=$(basename "$unit")
			if [[ "$unit_name" != "ctrlirl-emmc-install.service" ]]; then
				systemctl enable "$unit_name" 2>/dev/null || true
			fi
		done
	fi
fi

# ============================================================
# 10. eMMC-only: first-boot auto-installer
# ============================================================
if [[ "${BUILD_VARIANT:-sd}" == "emmc" ]]; then
	echo "Installing first-boot eMMC installer..."
	install -m 0755 /tmp/overlay/usr/local/sbin/ctrlirl-emmc-install.sh \
		/usr/local/sbin/ctrlirl-emmc-install.sh
	install -m 0644 /tmp/overlay/etc/systemd/system/ctrlirl-emmc-install.service \
		/etc/systemd/system/ctrlirl-emmc-install.service
	systemctl enable ctrlirl-emmc-install.service 2>/dev/null || true
fi

# ============================================================
# 11. Summary
# ============================================================
echo "Customization complete (hostname: ${HOSTNAME_VAL}, variant: ${BUILD_VARIANT:-sd})."
