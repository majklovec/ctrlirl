# 1. Instalace potřebných balíčků
apt update && apt install -y usb-modeswitch usb-modeswitch-data network-manager modemmanager
systemctl enable --now NetworkManager ModemManager

mkdir -p /etc/default /etc/modprobe.d /etc/sysctl.d /etc/udev/rules.d /etc/systemd/network /etc/systemd/resolved.conf.d

# 2. Automatické přepnutí modemu Huawei z režimu CD-ROM na síťovou kartu
echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", ATTR{idProduct}=="14fe", RUN+="/usr/sbin/usb_modeswitch -v 12d1 -p 14fe -J"' >/etc/udev/rules.d/40-huawei-modeswitch.rules

# 3. Blokace virtuální CD mechaniky (sr0) a úložiště modemu v udev i v jádře
echo 'ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_interface", ATTRS{idVendor}=="12d1", ATTR{bInterfaceClass}=="08", ATTR{authorized}="0"' >/etc/udev/rules.d/10-disable-huawei-storage.rules

envfile=/boot/armbianEnv.txt
quirks=0x12d1:0x14fe:i,0x12d1:0x1506:i
cp "$envfile" "$envfile.bak"
if grep -q '^usbstoragequirks=' "$envfile"; then
	grep -q '0x12d1:0x14fe:i' "$envfile" || sed -i "s/^usbstoragequirks=.*/&,$quirks/" "$envfile"
else
	echo "usbstoragequirks=$quirks" >>"$envfile"
fi

# 4. Obnovení klasických názvů síťových rozhraní (eth0, eth1, wlan0, wwan0...)
for f in /usr/lib/systemd/network/*.link /lib/systemd/network/*.link; do
	[ -e "$f" ] && ln -sf /dev/null "/etc/systemd/network/${f##*/}"
done

# 5. Nastavení DHCP klienta pro eth0
nmcli connection add type ethernet con-name eth0-dhcp ifname eth0 ipv4.method auto ipv6.method auto connection.autoconnect yes

cat <<'EOF' >/etc/systemd/resolved.conf.d/dns-override.conf
[Resolve]
DNS=9.9.9.9 8.8.8.8 8.8.4.4 1.1.1.1 
EOF

# 6. Konfigurační soubory (overlay /etc) — u-boot, modprobe, sysctl, udev
echo 'U_BOOT_PARAMETERS="console=ttyFIQ0,1500000 console=tty1 earlyprintk usb-storage.quirks=0x2537:0x1066:u,0x2537:0x1068:u cma=128M net.ifnames=0"' >/etc/default/u-boot
echo 'options usb-storage quirks=12d1:1506:i' >/etc/modprobe.d/huawei-ignore-storage.conf
echo 'net.core.rmem_max=8388608' >/etc/sysctl.d/30-belabox-rmem-max-8M.conf
echo 'net.ipv4.ip_default_ttl=65' >/etc/sysctl.d/30-belabox-ttl-65.conf
echo 'net.core.fb_tunnels_only_for_init_net = 2' >/etc/sysctl.d/99-no-fb-tunnels.conf

cat <<'EOF' >/etc/udev/rules.d/78-huawei.rules
ATTRS{idVendor}=="12d1", ATTRS{idProduct}=="1506", ENV{ID_MM_HUAWEI_NDISDUP_SUPPORTED}="1"
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", ATTR{idProduct}=="1506", ENV{UDISKS_IGNORE}="1"
EOF

cat <<'EOF' >/etc/udev/rules.d/80-rk3588-capture-cards.rules
ACTION!="add", GOTO="end"
SUBSYSTEM!="video4linux", GOTO="end"

ENV{ID_V4L_PRODUCT}=="rk_hdmirx", SYMLINK+="hdmirx", GOTO="end"

ENV{ID_BUS}=="usb", ENV{ID_V4L_CAPABILITIES}=="*:capture:*", ENV{DEVNAME}=="/dev/video*", SYMLINK+="usb_capture"

LABEL="end"
EOF

cat <<'EOF' >/etc/udev/rules.d/98-belaui-audio.rules
SUBSYSTEM!="sound", GOTO="end"
ENV{SOUND_INITIALIZED}!="1", GOTO="end"
ENV{ID_BUS}!="usb" GOTO="end"

ACTION=="remove", GOTO="signal_belaui"

ACTION!="change", GOTO="end"

# the Cam Link 4K's audio id defaults to C4K - don't modify it
ATTR{id}=="C4K", GOTO="signal_belaui"

# it looks like sometimes OA4 comes up without an ID, try to set it
ENV{ID_MODEL}=="OsmoAction4", ATTR{id}="OsmoAction4", GOTO="signal_belaui"

# don't rename the OP3 audio input
ATTR{id}=="DJIPocket3", GOTO="signal_belaui"

# the OA5's, OA6's and OP4's names might include part of the SN, discard it
ATTR{id}=="OsmoAction5*", ATTR{id}="OsmoAction5", GOTO="signal_belaui"
ATTR{id}=="OsmoAction6*", ATTR{id}="OsmoAction6", GOTO="signal_belaui"
ATTR{id}=="OsmoPocket4*", ATTR{id}="OsmoPocket4", GOTO="signal_belaui"

# set the id for the first USB audio card that's not a camlink 4K
ATTR{id}="usbaudio"

LABEL="signal_belaui"
RUN+="/usr/bin/pkill -o -SIGUSR2 -f belaUI.js"

LABEL="end"
EOF

cat <<'EOF' >/etc/udev/rules.d/99-usb-automount.rules
# USB automount rules — trigger a systemd service when storage is inserted.
# Unmounting is handled by systemd BindsTo= when the device disappears.
# Matches USB disks (sda1, sdb12) and SD cards (mmcblk0p1, mmcblk0p12).
ACTION=="add", SUBSYSTEM=="block", SUBSYSTEMS=="usb", KERNEL=="sd[a-z]*[0-9]*", ENV{ID_FS_USAGE}=="filesystem", TAG+="systemd", ENV{SYSTEMD_WANTS}="usb-automount@%k.service"
ACTION=="add", SUBSYSTEM=="block", KERNEL=="mmcblk[0-9]*p[0-9]*", ENV{ID_FS_USAGE}=="filesystem", TAG+="systemd", ENV{SYSTEMD_WANTS}="usb-automount@%k.service"
EOF

# 7. Aplikace a restart
update-initramfs -u
reboot
