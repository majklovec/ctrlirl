# 1. Instalace potřebných balíčků
apt update && apt install -y usb-modeswitch usb-modeswitch-data network-manager modemmanager
systemctl enable --now NetworkManager ModemManager

# 2. Automatické přepnutí modemu Huawei z režimu CD-ROM na síťovou kartu
cat <<'EOF' >/etc/udev/rules.d/40-huawei-modeswitch.rules
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", ATTR{idProduct}=="14fe", RUN+="/usr/sbin/usb_modeswitch -v 12d1 -p 14fe -J"
EOF

# 3. Blokace virtuální CD mechaniky (sr0) a úložiště modemu v udev i v jádře
cat <<'EOF' >/etc/udev/rules.d/10-disable-huawei-storage.rules
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_interface", ATTRS{idVendor}=="12d1", ATTR{bInterfaceClass}=="08", ATTR{authorized}="0"
EOF

cp /boot/armbianEnv.txt /boot/armbianEnv.txt.bak
if grep -q '^usbstoragequirks=' /boot/armbianEnv.txt; then
	grep -q '0x12d1:0x14fe:i' /boot/armbianEnv.txt || sed -i 's/^usbstoragequirks=.*/&,0x12d1:0x14fe:i,0x12d1:0x1506:i/' /boot/armbianEnv.txt
else
	echo 'usbstoragequirks=0x12d1:0x14fe:i,0x12d1:0x1506:i' >>/boot/armbianEnv.txt
fi

# 4. Obnovení klasických názvů síťových rozhraní (eth0, eth1, wlan0, wwan0...)
for f in /usr/lib/systemd/network/*.link /lib/systemd/network/*.link; do
	[ -e "$f" ] && ln -sf /dev/null "/etc/systemd/network/$(basename "$f")"
done
update-initramfs -u

# 5. Nastavení DHCP klienta pro eth0
nmcli connection add type ethernet con-name eth0-dhcp ifname eth0 ipv4.method auto ipv6.method auto connection.autoconnect yes

# 6. Aplikace a restart
udevadm control --reload-rules
reboot
