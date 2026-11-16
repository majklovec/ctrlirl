# -*- mode: ruby -*-
# vi: set ft=ruby :
#
# ctrlirl test environment: two Ubuntu 26.04 boxes
#   - encoder : runs the device client in the encoder role
#               (GStreamer encode pipeline via the committed ceracoder binary)
#   - relay   : runs the device client in the relay role
#               (UDP relay legs; iproute2 + raw sockets -> root)
#
# Topology
#   encoder  <--private link-->  relay  <--NAT-->  public internet
#
# Vagrant reserves eth0 for the default NAT network, so a custom network
# cannot be placed on eth0. The interface mapping is:
#
#   encoder  : eth0 = NAT (default),  eth1 = private link (192.168.56.10)
#   relay    : eth0 = NAT (internet), eth1 = private link (192.168.56.20)
#
# The repo is synced to /vagrant on both VMs; that is the working directory
# for the device clients (bun, generated/, node_modules land in the host repo).

Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-26.04"
  config.vm.box_version = "202606.01.0"

  link_prefix = "192.168.56"

  # ------------------------------------------------------------------
  # Shared infrastructure (both VMs)
  # ------------------------------------------------------------------

  config.vm.provision "common-packages", type: "shell", privileged: true, inline: <<-SHELL
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip \
      iproute2 tcpdump \
      build-essential cmake libssl-dev
    rm -rf /var/lib/apt/lists/*
  SHELL

  # Runs as root (provisioner shell here is root). The installer puts bun in
  # /root/.bun (unreadable by other users when run as root), so relocate it
  # to /opt/bun and expose it system-wide for the root-run systemd services.
  config.vm.provision "install-bun", type: "shell", privileged: true, inline: <<-SHELL
    set -euo pipefail
    rm -rf /opt/bun
    curl -fsSL https://bun.sh/install | bash
    mv /root/.bun /opt/bun
    ln -sf /opt/bun/bin/bun /usr/local/bin/bun
    /usr/local/bin/bun --version
  SHELL

  config.vm.provision "app-deps", type: "shell", privileged: true, inline: <<-SHELL
    set -euo pipefail
    # The synced repo is the runtime working directory for the device client.
    cd /vagrant
    /usr/local/bin/bun install --frozen-lockfile
  SHELL

  # ------------------------------------------------------------------
  # encoder
  # ------------------------------------------------------------------
  config.vm.define "encoder" do |enc|
    enc.vm.hostname = "encoder"
    enc.vm.network "private_network",
      ip: "#{link_prefix}.10",
      virtualbox__intname: "enc-relay"

    enc.vm.provider "virtualbox" do |vb|
      vb.name    = "ctrlirl-encoder"
      vb.memory  = 2048
      vb.cpus    = 2
    end

    # GStreamer encode pipeline (ceracoder) + the CERALIVE SRT fork the
    # committed ceracoder/srtla_send binaries link against (same as
    # Dockerfile.device - SRT is not apt-installable for this build).
    enc.vm.provision "encoder-runtime", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav gstreamer1.0-x \
        ffmpeg
      rm -rf /var/lib/apt/lists/*

      # CERALIVE SRT fork (v1.5.7) -> libsrt.so.1.5.7, bridged to libsrt.so.1.
      rm -rf /tmp/srt
      git clone --depth=1 https://github.com/CERALIVE/srt.git /tmp/srt
      cmake -S /tmp/srt -B /tmp/srt/build \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DENABLE_ENCRYPTION=ON -DCRYPTO=openssl
      cmake --build /tmp/srt/build --parallel "$(nproc)"
      cmake --install /tmp/srt/build
      ln -sf /usr/local/lib/libsrt.so.1.5.7 /usr/lib/x86_64-linux-gnu/libsrt.so.1
      ldconfig
      rm -rf /tmp/srt

      # srtla_send is a gitignored prebuilt binary on the host — install the
      # amd64 .deb release (same source as armbian/userpatches/customize-image.sh).
      srtla_deb_url=$(curl -fsSL "https://api.github.com/repos/irlserver/srtla_send/releases/latest" \
        | grep -oE '"browser_download_url":\s*"[^"]*amd64\.deb"' | head -n1 | cut -d '"' -f4)
      curl -fL -o /tmp/srtla_send.deb "${srtla_deb_url}"
      dpkg -i /tmp/srtla_send.deb
      rm -f /tmp/srtla_send.deb

      chmod +x /vagrant/ceracoder /vagrant/belacoder 2>/dev/null || true

      # GRETAP tunnel support (kernel; best-effort on box kernel).
      modprobe gretap 2>/dev/null || true
    SHELL

    enc.vm.provision "encoder-service", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      cat > /etc/systemd/system/ctrlirl-encoder.service <<'UNIT'
[Unit]
Description=ctrlirl device client (encoder role)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/vagrant
Environment=ENCODER_BIN=/vagrant/ceracoder
Environment=SRTLA_SEND_BIN=/usr/bin/srtla_send
ExecStart=/usr/local/bin/bun client/backend/client.ts --host 0.0.0.0 --port 8085 --role encoder --pipelines /vagrant/pipeline
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable --now ctrlirl-encoder.service
    SHELL
  end

  # ------------------------------------------------------------------
  # relay (internet uplink via default NAT)
  # ------------------------------------------------------------------
  config.vm.define "relay" do |rel|
    rel.vm.hostname = "relay"
    rel.vm.network "private_network",
      ip: "#{link_prefix}.20",
      virtualbox__intname: "enc-relay"
    # Optional physical uplink (adds eth2; find your interface with `ip a`):
    # rel.vm.network "public_network", bridge: "enp3s0"

    rel.vm.provider "virtualbox" do |vb|
      vb.name    = "ctrlirl-relay"
      vb.memory  = 2048
      vb.cpus    = 2
    end

    rel.vm.provision "relay-runtime", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        gstreamer1.0-tools gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly gstreamer1.0-libav
      rm -rf /var/lib/apt/lists/*

      # GRETAP tunnel support (kernel; best-effort on box kernel).
      modprobe gretap 2>/dev/null || true
    SHELL

    # Runs as root (raw sockets / SO_BINDTODEVICE) exactly like
    # scripts/run_udp_relay.ts expects.
    rel.vm.provision "relay-service", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      cat > /etc/systemd/system/ctrlirl-relay.service <<'UNIT'
[Unit]
Description=ctrlirl device client (relay role)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/vagrant
ExecStart=/usr/local/bin/bun client/backend/client.ts --host 0.0.0.0 --port 8085 --role ctrlink_relay --pipelines /vagrant/pipeline
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

      systemctl daemon-reload
      systemctl enable --now ctrlirl-relay.service
    SHELL
  end

  # ------------------------------------------------------------------
  # Optional: physical internet uplink for the relay.
  # The relay already has internet through its default NAT (eth0). To attach
  # it directly to your LAN / internet interface instead, uncomment the
  # "public_network" line in the relay block and set `bridge` to a host
  # interface (e.g. enp3s0). This adds eth2 to the relay.
  # ------------------------------------------------------------------
end
