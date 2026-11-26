#!/usr/bin/env bash
set -euo pipefail

# Check for broken global git URL rewrite rules
if git config --global --get-regexp '^url\..*\.insteadOf' >/dev/null 2>&1; then
    echo "WARNING: Found global git URL rewrite rules that may break github.com URLs:"
    git config --global --get-regexp '^url\..*\.insteadOf'
    echo "If git clone fails, remove them with: git config --global --remove-section url.<section>"
fi

# Verify we are on a Rockchip vendor kernel with hardware nodes present
if [[ ! -e /dev/mpp_service || ! -e /dev/rga ]]; then
    echo "WARNING: /dev/mpp_service or /dev/rga not found!"
    echo "Current kernel: $(uname -r)"
    echo "Hardware encoding/RGA requires a Rockchip 6.1 vendor kernel."
    read -p "Continue compiling anyway? (y/N): " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

BUILD_DIR="${HOME}/rk-gst-build"
mkdir -p "${BUILD_DIR}"

echo "=== 1. Installing build dependencies ==="
sudo apt-get update
sudo apt-get install -y \
    build-essential cmake meson ninja-build pkg-config git ca-certificates \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-gl gstreamer1.0-tools \
    libdrm-dev libx11-dev libwayland-dev libegl-dev libgles-dev

# ---------------------------------------------------------------------------
# 2. Rockchip MPP
# ---------------------------------------------------------------------------
echo "=== 2. Cloning and building MPP ==="
cd "${BUILD_DIR}"
rm -rf mpp-rockchip
git clone --depth=1 https://github.com/tsukumijima/mpp-rockchip mpp-rockchip
cmake -B mpp-rockchip/build -S mpp-rockchip \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_INSTALL_LIBDIR=lib/aarch64-linux-gnu \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DBUILD_TEST=OFF
cmake --build mpp-rockchip/build -j"$(nproc)"
sudo cmake --install mpp-rockchip/build

# ---------------------------------------------------------------------------
# 3. Rockchip RGA (librga)
# ---------------------------------------------------------------------------
echo "=== 3. Cloning and building librga ==="
cd "${BUILD_DIR}"
rm -rf librga-rockchip
git clone --depth=1 https://github.com/tsukumijima/librga-rockchip librga-rockchip
meson setup librga-rockchip/build librga-rockchip \
    --prefix=/usr \
    --libdir=lib/aarch64-linux-gnu \
    --buildtype=release
ninja -C librga-rockchip/build
sudo ninja -C librga-rockchip/build install

# ---------------------------------------------------------------------------
# 4. gstreamer-rockchip (mpph265enc, mppvideodec, rgaconvert)
# ---------------------------------------------------------------------------
echo "=== 4. Cloning and building gstreamer-rockchip ==="
cd "${BUILD_DIR}"
rm -rf gstreamer-rockchip
git clone --depth=1 --single-branch --branch gstreamer-rockchip https://github.com/JeffyCN/mirrors gstreamer-rockchip
meson setup gstreamer-rockchip/build gstreamer-rockchip \
    --prefix=/usr \
    --libdir=lib/aarch64-linux-gnu \
    --buildtype=release \
    -Drockchipmpp=enabled \
    -Drga=enabled
ninja -C gstreamer-rockchip/build
sudo ninja -C gstreamer-rockchip/build install

# ---------------------------------------------------------------------------
# 5. libv4l-rkmpp
# ---------------------------------------------------------------------------
echo "=== 5. Cloning and building libv4l-rkmpp ==="
cd "${BUILD_DIR}"
rm -rf libv4l-rkmpp
git clone --depth=1 https://github.com/JeffyCN/libv4l-rkmpp libv4l-rkmpp
meson setup libv4l-rkmpp/build libv4l-rkmpp \
    --prefix=/usr \
    --libdir=lib/aarch64-linux-gnu \
    --buildtype=release
ninja -C libv4l-rkmpp/build
sudo ninja -C libv4l-rkmpp/build install

# Refresh shared library cache and GStreamer plugin registry
sudo ldconfig
rm -rf "${HOME}/.cache/gstreamer-1.0"

echo "=== Build Complete! Verifying plugins ==="
gst-inspect-1.0 rockchipmpp
echo "-----------------------------------------"
gst-inspect-1.0 mpph265enc | grep -E "zero-copy-pkt|qp-max|gop|width|height" || true

