do not use subagents

encoder: ssh pi@192.168.10.104
relay: ssh user@192.168.1.211
test server: ssh vondracek.dev
Never ever change networking on test server!!

This is how to update ctrlirtl on relay and encoder:

bun run build:bundle && scp -r ./dist/bundles/client-arm/app pi@192.168.10.104:/home/pi && scp -r ./dist/bundles/client-arm/app user@192.168.1.211:/home/user

NOTE: ship the `app/` bundle, not the bare binary — the installer reads each
module's `install/` tree from `<binaryDir>/client/modules/<id>/install/` at
runtime, so a bare `dist/client-arm` never installs deps like srtla_send.
Deployed layout: /home/pi/app/client-arm + /home/pi/app/client/modules/<id>/install/

run:
This is how to update ctrlirtl on relay and encoder:

directories:
encoder: /home/pi
relay: /home/user

./client-arm --host 0.0.0.0

relay / enable routing:
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -i eth1 -o eth0 -j ACCEPT
sudo iptables -A FORWARD -i eth0 -o eth1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
