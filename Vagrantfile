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
#              eth2 = shared uplink  (192.168.57.20, host at .1)
#              eth3 = shared uplink  (192.168.58.20, host at .1)
#
# Host UI access (forwarded ports):
#   relay   : http://127.0.0.1:28085  (CTRLIRL_RELAY_UI_PORT to override)
#   encoder : http://127.0.0.1:18085
#
# USB cellular dongles plugged into the host are passed through to the relay
# (see MODEM_VENDOR_VIDS / RELAY_USB_MODEMS below).
#
# The repo is synced to /vagrant on both VMs; that is the working directory
# for the device clients (bun, generated/, node_modules land in the host repo).

# Extra uplink legs on the relay: host-shared subnets. Vagrant auto-creates
# the host-only adapter (and gives the host the .1 address) when the
# virtualbox__intname doesn't exist yet — the same path as the enc-relay link.
SHARED_SUBNETS = ["192.168.57", "192.168.58"].freeze

# USB modem passthrough to the relay. Exact vid:pid pairs (VirtualBox 7.2
# filters have no wildcards). Defaults to auto-detection of common 3G/4G/5G
# dongle vendor VIDs on the host; override with explicit pairs:
#   RELAY_USB_MODEMS="12d1:1506,19d2:0010" vagrant up relay
MODEM_VENDOR_VIDS = %w[12d1 1004 19d2 0930 0f3d 1bc7 0421 2c7c 2c9c 1e2e].freeze
explicit_modems = (ENV["RELAY_USB_MODEMS"] || "").split(",").map(&:strip).reject(&:empty?)
detected_modems = `lsusb 2>/dev/null`
  .scan(/\bID ([0-9a-fA-F]{4}:[0-9a-fA-F]{4})/)
  .flatten
  .select { |pair| MODEM_VENDOR_VIDS.include?(pair[0, 4].downcase) }
modem_pairs = (explicit_modems + detected_modems).uniq.freeze

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

    # encoder Web UI / WS API on the host: http://127.0.0.1:18085
    enc.vm.network "forwarded_port", guest: 8085, host: 18085, host_ip: "127.0.0.1"

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
    # Extra uplink legs: host-shared subnets (host can reach the relay on
    # them; the relay's modems module counts each as an uplink).
    SHARED_SUBNETS.each do |cidr|
      rel.vm.network "private_network",
        ip: "#{cidr}.20",
        virtualbox__intname: "relay-up-#{cidr.tr(".", "-")}"
    end
    # relay Web UI / WS API on the host: http://127.0.0.1:28085
    # (8085 itself is taken by the local dev client from run.sh; override with
    #  CTRLIRL_RELAY_UI_PORT=8085 once that process is stopped.)
    rel.vm.network "forwarded_port",
      guest: 8085, host: ENV.fetch("CTRLIRL_RELAY_UI_PORT", "28085").to_i, host_ip: "127.0.0.1"
    # Optional physical uplink: rel.vm.network "public_network", bridge: "enp3s0"

    rel.vm.provider "virtualbox" do |vb|
      vb.name    = "ctrlirl-relay"
      vb.memory  = 2048
      vb.cpus    = 2
      # One USB filter per modem -> the dongle is grabbed by the relay.
      # (VBox 7.2 usbfilter syntax; remove-then-add keeps reloads idempotent.)
      modem_pairs.each_with_index do |pair, idx|
        vid, pid = pair.split(":")
        vb.customize ["usbfilter", "remove", idx.to_s, "--target", "ctrlirl-relay"]
        vb.customize ["usbfilter", "add", idx.to_s, "--target", "ctrlirl-relay",
          "--name", "ctrlirl-modem-#{vid}-#{pid}", "--vendorid", vid, "--productid", pid]
      end
    end

    rel.vm.provision "relay-runtime", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        gstreamer1.0-tools gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly gstreamer1.0-libav \
        usb-modeswitch usbutils
      rm -rf /var/lib/apt/lists/*

      # GRETAP tunnel support (kernel; best-effort on box kernel).
      modprobe gretap 2>/dev/null || true
      # USB cellular modems (host-attached dongles are passed through).
      for m in qmi_wwan cdc_wwan option usbnet cdc_ncm; do modprobe $m 2>/dev/null || true; done
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
