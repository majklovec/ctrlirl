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
#   internet -- LAN (192.168.1.0/24, router 192.168.1.1)
#                |
#             relay eth0  (bridged to the host's LAN interface, 192.168.1.x)
#             relay  + USB modem (second uplink)
#                |
#             relay eth1 (192.168.101.1)  <-- private link -->  encoder (192.168.101.10)
#
# The relay is the encoder's router + NAT: the encoder has no NAT interface
# of its own and reaches the internet only through the relay.
#
# UI access (over the LAN, since the relay is bridged):
#   relay   : http://192.168.1.x:8085   (192.168.101.1:8085 on the link)
#   encoder : http://192.168.101.10:8085 (via the relay)
#
# USB cellular dongles plugged into the host are passed through to the relay
# (see MODEM_VENDOR_VIDS / RELAY_USB_MODEMS below).
#
# The repo is synced to /vagrant on both VMs; that is the working directory
# for the device clients (bun, generated/, node_modules land in the host repo).

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

# USB filters are per-VM settings that survive `vagrant up`, and
# `VBoxManage usbfilter remove <idx>` hard-errors on a fresh VM whose filter
# list is empty (VBoxManage 7.2 also dropped `usbfilter list`). Clearing
# stale filters by name at load time — via `showvminfo --machinereadable`,
# which numbers filters 1-based — keeps the plain `usbfilter add`
# customizations idempotent. A running VM is left alone: its filters are
# only re-applied at boot.
def clear_stale_modem_filters(filter_names, target)
  state = `VBoxManage showvminfo #{target} --machinereadable 2>/dev/null`
  return if $?.nil? || !$?.success?
  return unless /^VMState="(?:poweroff|saved)"/.match?(state)
  info = `VBoxManage showvminfo #{target} --machinereadable 2>/dev/null`
  return if $?.nil? || !$?.success?
  info.scan(/^USBFilterName(\d+)="(.*)"/)
     .select { |_idx, name| filter_names.include?(name) }
     .map { |idx, _| idx.to_i }
     .sort.reverse # indices shift after each removal
     .each { |idx| system("VBoxManage usbfilter remove #{idx - 1} --target #{target} >/dev/null 2>&1") }
end

clear_stale_modem_filters(modem_pairs.map { |p| "ctrlirl-modem-#{p.tr(":", "-")}" }, "ctrlirl-relay")

Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-26.04"
  config.vm.box_version = "202606.01.0"

  link_prefix = "192.168.101"

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
      # The encoder must not have its own NAT uplink: the relay is its only
      # route out (router + NAT for 192.168.101.0/24).
      vb.customize "pre-boot", ["modifyvm", :id, "--nic1", "null"]
    end

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
  # relay (uplinks: bridged LAN + USB modem; downstream link to the encoder)
  # ------------------------------------------------------------------
  config.vm.define "relay" do |rel|
    rel.vm.hostname = "relay"
    # eth0: bridge onto the host's LAN interface -> 192.168.1.x via the
    # main router's DHCP (RELAY_LAN_BRIDGE overrides the interface).
    rel.vm.network "public_network",
      bridge: ENV.fetch("RELAY_LAN_BRIDGE", "eno2")
    # eth1: private link to the encoder; the relay is this subnet's gateway.
    rel.vm.network "private_network",
      ip: "#{link_prefix}.1",
      virtualbox__intname: "enc-relay"

    rel.vm.provider "virtualbox" do |vb|
      vb.name    = "ctrlirl-relay"
      vb.memory  = 2048
      vb.cpus    = 2
      # Remove the leftover host-only adapters from the previous layout
      # (192.168.56/57/58) once nothing references them anymore.
      vb.destroy_unused_network_interfaces = true
      # USB controller; required for the modem filters below (applied per
      # boot, since it cannot be toggled on a running VM)
      vb.customize "pre-boot", ["modifyvm", :id, "--usb", "on"]
      # One USB filter per modem -> the dongle is grabbed by the relay.
      # (clear_stale_modem_filters() at file load time keeps re-runs idempotent.)
      modem_pairs.each_with_index do |pair, idx|
        vid, pid = pair.split(":")
        vb.customize ["usbfilter", "add", idx.to_s, "--target", "ctrlirl-relay",
          "--name", "ctrlirl-modem-#{vid}-#{pid}", "--vendorid", vid, "--productid", pid]
      end
    end



    # The relay routes + NATs the encoder subnet out through the uplinks
    # (bridged LAN and USB modem). eth1 is the encoder link; masquerade is
    # applied on every other outgoing interface, wherever the modem shows up.
    rel.vm.provision "relay-nat", type: "shell", privileged: true, inline: <<-SHELL
      set -euo pipefail
      echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-ctrlirl-relay.conf
      sysctl -w net.ipv4.ip_forward=1 >/dev/null
      nft delete table ip ctrlirl_nat 2>/dev/null || true
      nft add table ip ctrlirl_nat
      nft add chain ip ctrlirl_nat postrouting '{ type nat hook postrouting priority 100 ; }'
      nft add rule ip ctrlirl_nat postrouting ip saddr 192.168.101.0/24 oifname .!= "eth1" masquerade
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

  # The relay's uplinks:
  #   1. eth0 bridged onto the host's LAN (RELAY_LAN_BRIDGE, default eno2)
  #   2. the USB modem passed through via the filters above
end
